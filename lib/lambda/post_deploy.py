import boto3 # type: ignore
from botocore.config import Config # type: ignore
import json
import re
import os
import logging
from datetime import datetime

logger = logging.getLogger()
logger.setLevel(logging.INFO)

PASSWORD_MARKER = '**** GENERATED PASSWORD'
PASSWORD_REGEX = r'^[A-Za-z0-9]{20,}$'
SIGNING_KEY_REGEX = r'^[0-9a-f]{4}\s+[0-9a-f]{4}'
REDACTED_TEXT = '[REDACTED]'

def get_log_events(logs_client, log_group_name, stream_name):
    """Get all log events from a stream with pagination"""
    log_events = []
    next_token = None
    
    while True:
        params = {
            'logGroupName': log_group_name,
            'logStreamName': stream_name,
            'startFromHead': True
        }
        if next_token:
            params['nextToken'] = next_token
        
        events = logs_client.get_log_events(**params)
        log_events.extend(events['events'])
        
        next_forward_token = events.get('nextForwardToken')
        if next_forward_token == next_token:
            break
        next_token = next_forward_token
    
    return log_events

def find_password(log_events):
    """Find password in log events"""
    for i, event in enumerate(log_events):
        if PASSWORD_MARKER in event['message']:
            for j in range(i + 1, len(log_events)):
                next_message = log_events[j]['message'].strip()
                if re.match(PASSWORD_REGEX, next_message):
                    return next_message
    return None

def extract_public_key(log_events):
    """Extract public key from log events"""
    public_key = ""
    for event in log_events:
        if re.match(SIGNING_KEY_REGEX, event['message']):
            public_key += event['message'].strip() + '\n'
    return public_key

def update_secret_password(secrets_client, secret_arn, password):
    """Update password in secrets manager while preserving other data"""
    try:
        existing_secret = secrets_client.get_secret_value(SecretId=secret_arn)
        secret_data = json.loads(existing_secret['SecretString'])
        logger.info(f"Existing secret keys: {list(secret_data.keys())}")
    except Exception as e:
        logger.warning(f"Could not read existing secret: {e}")
        secret_data = {}
    
    secret_data['password'] = password
    logger.info(f"Updated secret keys: {list(secret_data.keys())}")
    
    secrets_client.update_secret(
        SecretId=secret_arn,
        SecretString=json.dumps(secret_data)
    )

def redact_log_stream(logs_client, log_group_name, stream_name, log_events):
    """Redact password from log stream"""
    redacted_events = []
    redacted_count = 0
    
    for event in log_events:
        message = event['message']
        if re.match(PASSWORD_REGEX, message.strip()):
            message = REDACTED_TEXT
            redacted_count += 1
        
        redacted_events.append({
            'timestamp': event['timestamp'],
            'message': message
        })
    
    # Replace log stream
    logs_client.delete_log_stream(
        logGroupName=log_group_name,
        logStreamName=stream_name
    )
    logs_client.create_log_stream(
        logGroupName=log_group_name,
        logStreamName=stream_name
    )
    
    if redacted_events:
        logs_client.put_log_events(
            logGroupName=log_group_name,
            logStreamName=stream_name,
            logEvents=redacted_events
        )
    
    return redacted_count

def upload_public_key(s3_client, bucket_name, kms_key_id, public_key):
    """Upload public key to S3"""
    s3_client.put_object(
        Bucket=bucket_name,
        Key='bot_public_key.txt',
        Body=public_key,
        ServerSideEncryption='aws:kms',
        SSEKMSKeyId=kms_key_id
    )

def lambda_handler(event, context):
    logger.info("Starting password processor Lambda function")
    
    try:
        # Get environment variables
        log_group_name = os.environ['LOG_GROUP_NAME']
        secret_arn = os.environ['SECRET_ARN']
        bucket_name = os.environ['BUCKET_NAME']
        kms_key_id = os.environ['KMS_KEY_ID']
        region = os.environ['AWS_REGION']
        
        logger.info(f"Processing log group: {log_group_name}")
        
        # Initialize AWS clients
        boto_config = Config(
            retries={"max_attempts": 10, "mode": "adaptive"},
            use_fips_endpoint=True if region.startswith(('us', 'ca')) else None
        )
        logs_client = boto3.client('logs', config=boto_config)
        secrets_client = boto3.client('secretsmanager', config=boto_config)
        s3_client = boto3.client('s3', config=boto_config)
        
        # Get all log streams with pagination
        all_streams = []
        next_token = None
        
        while True:
            params = {
                'logGroupName': log_group_name,
                'orderBy': 'LastEventTime',
                'descending': True
            }
            if next_token:
                params['nextToken'] = next_token
            
            streams = logs_client.describe_log_streams(**params)
            all_streams.extend(streams['logStreams'])
            
            next_token = streams.get('nextToken')
            if not next_token:
                break
        
        logger.info(f"Found {len(all_streams)} log streams")
        
        password_found = False
        public_key = ""
        
        for stream_idx, stream in enumerate(all_streams):
            stream_name = stream['logStreamName']
            logger.info(f"Processing stream {stream_idx + 1}: {stream_name}")
            
            log_events = get_log_events(logs_client, log_group_name, stream_name)
            logger.debug(f"Found {len(log_events)} log events")
            
            # Skip if already redacted
            if any(REDACTED_TEXT in event['message'] for event in log_events):
                logger.info("Stream already processed, skipping")
                continue
            
            # Find password
            if not password_found:
                password = find_password(log_events)
                if password:
                    logger.info(f"Found a password")
                    update_secret_password(secrets_client, secret_arn, password)
                    logger.info("Password updated in Secrets Manager")
                    password_found = True
            
            # Extract public key
            stream_public_key = extract_public_key(log_events)
            if stream_public_key:
                public_key += stream_public_key
            
            # Redact logs if password was found
            if password_found:
                try:
                    redacted_count = redact_log_stream(logs_client, log_group_name, stream_name, log_events)
                    logger.info(f"Redacted {redacted_count} password lines")
                except Exception as e:
                    logger.error(f"Failed to redact stream {stream_name}: {e}")
        
        # Upload public key to S3
        if public_key:
            try:
                upload_public_key(s3_client, bucket_name, kms_key_id, public_key)
                logger.info(f"Public key uploaded ({len(public_key.splitlines())} lines)")
            except Exception as e:
                logger.error(f"Failed to upload public key: {e}")
        else:
            logger.warning("No public key found")
        
        logger.info(f"Completed: Password found: {password_found}, Public key found: {bool(public_key)}")
        
        return {
            'Status': 'SUCCESS',
            'PhysicalResourceId': f'post-deploy-{int(datetime.now().timestamp())}'
        }
        
    except Exception as error:
        logger.error(f"FATAL ERROR: {error}")
        import traceback
        logger.error(f"Stack trace: {traceback.format_exc()}")
        return {
            'Status': 'FAILED',
            'Reason': str(error),
            'PhysicalResourceId': 'post-deploy-failed'
        }
    