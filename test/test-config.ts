import { RemovalPolicy } from 'aws-cdk-lib';
import { PerformanceMode, ThroughputMode } from 'aws-cdk-lib/aws-efs';
import { WickrConfig } from '../types/config';
import { ContainerInsights } from 'aws-cdk-lib/aws-ecs';

export const testConfig: WickrConfig = {
  accountId: '123456789012',
  region: 'us-east-1',
  prefix: 'test-wickr-drb',

  vpcId: 'vpc-test123',
  subnetIds: ['subnet-test123', 'subnet-test456'],

  wickrBotName: 'test-bot',
  wickrCompTimeRotation: 15,
  containerImageUri: 'test-image:latest',

  dataExpirationInYears: 1,
  enableS3ServerAccessLogs: false,
  s3ObjectLock: false,
  efsPerformanceMode: PerformanceMode.GENERAL_PURPOSE,
  efsThroughputMode: ThroughputMode.BURSTING,
  efsEnableAutomaticBackups: false,

  ecsCpu: 512,
  ecsMemory: 1024,
  ecsContainerInsights: ContainerInsights.ENABLED,

  removalPolicy: RemovalPolicy.DESTROY,
  tags: { Environment: 'test' }
};
