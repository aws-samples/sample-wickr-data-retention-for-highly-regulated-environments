#!/usr/bin/env python3
"""Wickr Data Retention Bot - Message Decryption Utility

Decrypts messages stored by the Wickr Data Retention Bot from AWS S3.

"""

import argparse
import base64
import json
import sys
from pathlib import Path

import boto3
from botocore.config import Config
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def decrypt_message(bucket, key, region, output_file):
    """Decrypt a Wickr message from S3."""

    boto_config = Config(
        region_name=region,
        use_fips_endpoint=True if region.startswith(('us', 'ca')) else None
    )

    s3 = boto3.client("s3", config=boto_config)
    kms = boto3.client("kms", config=boto_config)
    
    # Fetch object + metadata
    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
        body = obj["Body"].read()
        meta = obj.get("Metadata", {})
    except Exception as e:
        sys.exit(f"Error fetching S3 object: {e}")
    
    def get_metadata(k):
        v = meta.get(k)
        if v is None:
            sys.exit(f"Missing required metadata: {k}")
        return v
    
    # Extract encryption metadata
    iv_b64 = get_metadata("x-amz-iv")
    key_v2_b64 = get_metadata("x-amz-key-v2")
    tag_len_bits = int(get_metadata("x-amz-tag-len"))
    matdesc_json = get_metadata("x-amz-matdesc")
    
    # Decode fields
    iv = base64.b64decode(iv_b64)
    edk = base64.b64decode(key_v2_b64)
    
    if tag_len_bits % 8 != 0:
        sys.exit("x-amz-tag-len not multiple of 8")
    tag_len = tag_len_bits // 8
    
    # Decrypt data key with KMS
    try:
        encryption_context = json.loads(matdesc_json)
        dek_plain = kms.decrypt(
            CiphertextBlob=edk,
            EncryptionContext=encryption_context
        )["Plaintext"]
    except Exception as e:
        sys.exit(f"Error decrypting data key: {e}")
    
    # Split ciphertext and GCM tag
    if len(body) < tag_len:
        sys.exit("Object too small to contain a GCM tag")
    ciphertext = body[:-tag_len]
    tag = body[-tag_len:]
    
    # AES-GCM decrypt
    try:
        aesgcm = AESGCM(dek_plain)
        plaintext = aesgcm.decrypt(iv, ciphertext + tag, None)
    except Exception as e:
        sys.exit(f"Error decrypting message: {e}")
    
    # Write result
    try:
        with open(output_file, "wb") as f:
            f.write(plaintext)
        print(f"Decrypted → {output_file}")
    except Exception as e:
        sys.exit(f"Error writing output file: {e}")


def main():
    parser = argparse.ArgumentParser(
        description="Decrypt Wickr Data Retention Bot messages from S3",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  %(prog)s -b my-bucket -k data/message.txt -o decrypted.txt
  %(prog)s -b my-bucket -k data/attachment.pdf -r us-west-2 -o file.pdf"""
    )
    
    parser.add_argument("-b", "--bucket", required=True,
                       help="S3 bucket name containing encrypted message")
    parser.add_argument("-k", "--key", required=True,
                       help="S3 object key (path) to encrypted message")
    parser.add_argument("-r", "--region", default="us-east-1",
                       help="AWS region (default: us-east-1)")
    parser.add_argument("-o", "--output", required=True,
                       help="Output file path for decrypted message")
    
    args = parser.parse_args()
    
    # Validate output directory exists
    output_path = Path(args.output)
    if not output_path.parent.exists():
        sys.exit(f"Output directory does not exist: {output_path.parent}")
    
    decrypt_message(args.bucket, args.key, args.region, args.output)


if __name__ == "__main__":
    main()