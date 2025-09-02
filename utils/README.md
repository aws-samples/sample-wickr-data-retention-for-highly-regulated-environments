# Wickr Data Retention Bot - Message Decryption Utility

A command-line utility to decrypt messages stored by the Wickr Data Retention Bot from AWS S3.

## Prerequisites

- Python 3.10+
- AWS CLI configured with appropriate permissions
- Access to the S3 bucket containing encrypted messages
- KMS decrypt permissions for the encryption keys

## Installation

```bash
cd utils/
pip install boto3 cryptography
```

## Usage

```bash
python decrypt_s3_object.py -b BUCKET -k KEY -o OUTPUT_FILE [-r REGION]
```

### Arguments

- `-b, --bucket`: S3 bucket name containing the encrypted message (required)
- `-k, --key`: S3 object key (path) to the encrypted message (required)
- `-o, --output`: Output file path for the decrypted message (required)
- `-r, --region`: AWS region (default: us-east-1)

### Examples

```bash
# Decrypt a text message
## Wickr message files are in JSONL format
python decrypt_s3_object.py -b my-bucket -k data/29250339 -o message.jsonl

# Decrypt an attachment with custom region
python decrypt_s3_object.py -b my-bucket -k data/attachment.pdf -r us-west-2 -o file.pdf

# Show help
python decrypt_s3_object.py --help
```

## How It Works

The utility:

1. Fetches the encrypted object and metadata from S3
2. Extracts encryption parameters from S3 metadata
3. Decrypts the data encryption key using AWS KMS
4. Decrypts the message content using AES-GCM
5. Writes the plaintext to the specified output file

## Error Handling

The script will exit with an error message if:

- S3 object cannot be accessed
- Required encryption metadata is missing
- KMS decryption fails
- Message decryption fails
- Output file cannot be written
