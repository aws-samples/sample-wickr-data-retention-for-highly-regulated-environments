import { StackProps } from 'aws-cdk-lib';
import { SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { FileSystem } from 'aws-cdk-lib/aws-efs';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

/**
 * Internal stack properties passed from prerequisites to main stack.
 * Contains AWS resources created by the prerequisites stack.
 */
export interface WickrDRBStackProps extends StackProps {
  dataBucket: Bucket;
  efs: FileSystem;
  wickrSecret: Secret;
  ecsConfigSecret: Secret;
  efsSG: SecurityGroup;
  ecsSG: SecurityGroup;
  infraKey: Key;
  dataKey: Key;
}
