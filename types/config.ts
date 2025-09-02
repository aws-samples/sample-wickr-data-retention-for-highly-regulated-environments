import { RemovalPolicy } from 'aws-cdk-lib';
import { ContainerInsights } from 'aws-cdk-lib/aws-ecs';
import { PerformanceMode, ThroughputMode } from 'aws-cdk-lib/aws-efs';

export interface WickrConfig {
  // Core deployment configuration
  /**
   * Your 12-digit AWS Account ID where all resources deploy.
   * Find this in your AWS Console under Account Settings.
   * @see https://docs.aws.amazon.com/general/latest/gr/acct-identifiers.html
   */
  accountId: string;

  /**
   * AWS Region for all resource deployment.
   * Choose based on your data residency requirements and user proximity.
   * Examples: us-east-1, us-west-2, us-gov-west-1
   * @see https://docs.aws.amazon.com/general/latest/gr/rande.html
   */
  region: string;

  /**
   * Unique prefix for all resource names to prevent naming conflicts.
   * Use your organization identifier or project code.
   * Example: 'mycompany-wickr-drb' creates resources like 'mycompany-wickr-drb-bucket'
   */
  prefix: string;

  // Network infrastructure settings
  /**
   * VPC ID where your ECS tasks execute.
   * Must be an existing VPC with internet gateway access for container image pulls.
   * Format: vpc-xxxxxxxxx
   * @see https://docs.aws.amazon.com/vpc/latest/userguide/what-is-amazon-vpc.html
   */
  vpcId: string;

  /**
   * Private subnet IDs for ECS task placement and EFS mount targets.
   * Requires at least 2 subnets in different availability zones for high availability.
   * Each subnet must have NAT gateway access for outbound internet connectivity.
   * @see https://docs.aws.amazon.com/vpc/latest/userguide/configure-subnets.html
   */
  subnetIds: string[];

  // Wickr bot application settings
  /**
   * Wickr Data Retention Bot identifier from your Wickr Admin Console.
   * Format: compliance_XXXXXXXX_bot where X represents your network-specific numbers.
   * Find this under Network Settings > Data Retention in Wickr Admin Console.
   * @see https://docs.aws.amazon.com/wickr/latest/adminguide/data-retention.html
   */
  wickrBotName: string;

  /**
   * Time rotation interval in minutes for message file creation.
   * Controls how frequently the bot creates new message files.
   * Lower values create more files but enable faster processing.
   * Recommended range: 5-60 minutes based on message volume.
   */
  wickrCompTimeRotation: number;

  /**
   * Docker container image URI for the Wickr compliance bot.
   * Use official Wickr images from AWS ECR Gallery (recommended) or your own registry.
   *
   * AWS ECR Gallery options:
   * - Wickr: public.ecr.aws/x3s2s6k3/wickrio/bot-compliance-cloud:latest
   * - WickrGov: public.ecr.aws/x3s2s6k3/wickrio/bot-dataretention-govcloud:latest
   *
   * @see https://docs.aws.amazon.com/AmazonECR/latest/userguide/what-is-ecr.html
   */
  containerImageUri: string;

  // Data lifecycle and storage policies
  /**
   * Data retention period in years before automatic deletion.
   * Set to 0 for infinite retention (not recommended for cost optimization).
   * Consider your compliance requirements: GDPR (7 years), SOX (7 years), HIPAA (6 years).
   * @see https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/Working-with-log-groups-and-streams.html#SttingLogRetention
   * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html
   */
  dataExpirationInYears: number;

  /**
   * Enable detailed S3 access logging for compliance and audit requirements.
   * Creates additional logs showing who accessed retained messages and when.
   * Increases storage costs but provides complete audit trail.
   * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/ServerLogs.html
   */
  enableS3ServerAccessLogs: boolean;

  /**
   * The default retention mode and rules for S3 Object Lock.
   *
   * Default retention can be configured after a bucket is created if the bucket already
   * has object lock enabled. Enabling object lock for existing buckets is not supported.
   *
   * With `governance` mode, you protect objects against being deleted by most users, but you can
   * still grant some users permission to alter the retention settings or delete the object if
   * necessary. You can also use governance mode to test retention-period settings before
   * creating a compliance-mode retention period.
   *
   * With `compliance` mode, its retention mode can't be changed, and
   * its retention period can't be shortened. Compliance mode helps ensure that an object
   * version can't be overwritten or deleted for the duration of the retention period.
   *
   * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-overview.html#object-lock-bucket-config-enable
   *
   */
  s3ObjectLock: S3ObjectLock;

  // EFS file system performance tuning
  /**
   * EFS performance mode selection affects IOPS and latency characteristics.
   * GENERAL_PURPOSE: Lower latency, up to 7,000 file operations per second
   * MAX_IO: Higher aggregate throughput, higher latencies per operation
   * Choose GENERAL_PURPOSE unless you need extreme throughput.
   * @see https://docs.aws.amazon.com/efs/latest/ug/performance.html
   */
  efsPerformanceMode: PerformanceMode;

  /**
   * EFS throughput mode determines how throughput scales with file system size.
   * BURSTING: Throughput scales with file system size (default, most cost-effective)
   * PROVISIONED: Fixed throughput regardless of size (predictable performance)
   * ELASTIC: Automatically scales throughput up and down (newest option)
   * @see https://docs.aws.amazon.com/efs/latest/ug/performance.html#throughput-modes
   */
  efsThroughputMode: ThroughputMode;

  /**
   * Enable EFS automatic backups for daily point-in-time snapshots.
   * Creates recovery options for your message data using EFS built-in backup.
   * Adds backup storage costs but provides disaster recovery capability.
   * @see https://docs.aws.amazon.com/efs/latest/ug/awsbackup.html
   */
  efsEnableAutomaticBackups: boolean;

  // ECS task compute resource allocation
  /**
   * CPU units allocated to the Fargate task (1024 units = 1 vCPU).
   * Higher values improve message processing speed but increase costs.
   * Start with 1024 and scale up if you see CPU throttling in CloudWatch.
   * @see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html#fargate-tasks-size
   */
  ecsCpu: number;

  /**
   * Memory allocation in megabytes for the Fargate task.
   * Must be compatible with your CPU allocation per AWS Fargate requirements.
   * Higher memory supports larger message batches and faster processing.
   * @see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html#fargate-tasks-size
   */
  ecsMemory: number;

  /**
   * CloudWatch Container Insights monitoring level for ECS cluster.
   * ENABLED: Detailed container-level metrics and logs (additional costs)
   * DISABLED: Basic ECS metrics only (cost-effective)
   * @see https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/ContainerInsights.html
   */
  ecsContainerInsights: ContainerInsights;

  // Infrastructure lifecycle management
  /**
   * CDK removal policy controlling what happens to resources during stack deletion.
   * RETAIN: Keep resources after stack deletion (recommended for production data)
   * DESTROY: Delete resources with stack (use only for development/testing)
   * SNAPSHOT: Create final backup before deletion (databases only)
   * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-deletionpolicy.html
   */
  removalPolicy: RemovalPolicy;

  /**
   * AWS resource tags applied to all created resources for organization and billing.
   * Use consistent tagging strategy across your organization.
   * Common tags: Environment, Owner, Project, CostCenter, Compliance
   * @see https://docs.aws.amazon.com/whitepapers/latest/tagging-best-practices/tagging-best-practices.html
   */
  tags: {
    [key: string]: string;
  };
}
export type S3ObjectLock = 'compliance' | 'governance' | false;
