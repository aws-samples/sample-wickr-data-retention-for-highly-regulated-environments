import { RemovalPolicy } from 'aws-cdk-lib';
import { PerformanceMode, ThroughputMode } from 'aws-cdk-lib/aws-efs';
import { WickrConfig } from '../types/config';
import { ContainerInsights } from 'aws-cdk-lib/aws-ecs';

/**
 * Wickr Data Retention Bot Configuration
 *
 * This configuration defines all the settings for deploying the Wickr Data Retention Bot
 * infrastructure including networking, storage, compute resources, and data retention policies.
 *
 * For detailed documentation on each configuration option including AWS service links,
 * see the WickrConfig interface in types/config.ts or hover over any property below.
 */
const config: WickrConfig = {
  accountId: '783138895180',
  region: 'us-east-1',
  prefix: 'wickr-drb-7',

  vpcId: 'vpc-040387ad6451c4806',
  subnetIds: ['subnet-0d78d5ca17bd11427', 'subnet-0e76caecb45de18df'],

  wickrBotName: 'compliance_82472932_bot',
  wickrCompTimeRotation: 5,

  containerImageUri: 'public.ecr.aws/x3s2s6k3/wickrio/bot-compliance-cloud:latest',

  dataExpirationInYears: 5,
  enableS3ServerAccessLogs: true,
  s3ObjectLock: false,

  efsPerformanceMode: PerformanceMode.GENERAL_PURPOSE,
  efsThroughputMode: ThroughputMode.BURSTING,
  efsEnableAutomaticBackups: true,

  ecsCpu: 1024,
  ecsMemory: 2048,
  ecsContainerInsights: ContainerInsights.ENABLED,

  removalPolicy: RemovalPolicy.RETAIN,
  tags: { Application: 'Wickr Data Retention Bot' }
};

export default config;
