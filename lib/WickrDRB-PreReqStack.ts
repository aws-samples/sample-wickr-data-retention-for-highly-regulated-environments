import { Construct } from 'constructs';
import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';

import config from '../bin/config';

import { SecurityGroup, SubnetFilter, Vpc, Port, Peer } from 'aws-cdk-lib/aws-ec2';
import { FileSystem } from 'aws-cdk-lib/aws-efs';
import { Key } from 'aws-cdk-lib/aws-kms';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectLockRetention } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { AnyPrincipal, Effect, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { S3ObjectLock } from '../types/config';
import { CfnRule } from 'aws-cdk-lib/aws-events';

export class WickrDRBPreReqStack extends Stack {
  public readonly dataBucket: Bucket;
  public readonly serverAccessBucket?: Bucket;
  public readonly efs: FileSystem;
  public readonly wickrSecret: Secret;
  public readonly ecsConfigSecret: Secret;
  public readonly efsSG: SecurityGroup;
  public readonly ecsSG: SecurityGroup;
  public readonly infraKey: Key;
  public readonly dataKey: Key;
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const {
      prefix,
      vpcId,
      subnetIds,
      removalPolicy,
      dataExpirationInYears,
      enableS3ServerAccessLogs,
      s3ObjectLock,
      efsPerformanceMode,
      efsThroughputMode,
      efsEnableAutomaticBackups,
      wickrBotName,
      wickrCompTimeRotation
    } = config;

    const vpc = Vpc.fromLookup(this, 'VPC', { vpcId });
    const subnetFilter = { subnetFilters: [SubnetFilter.byIds(subnetIds)] };

    this.infraKey = new Key(this, 'Infra-Key', {
      enableKeyRotation: true,
      removalPolicy: removalPolicy
    });

    this.dataKey = new Key(this, 'Data-Key', {
      enableKeyRotation: true,
      removalPolicy: removalPolicy
    });

    this.infraKey.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        principals: [new ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': [
              `arn:aws:logs:${this.region}:${this.account}:log-group:/ecs/${prefix}/*`,
              `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${prefix}*`
            ]
          }
        }
      })
    );

    let serverAccessBucket: Bucket | undefined;
    if (enableS3ServerAccessLogs === true) {
      this.serverAccessBucket = new Bucket(this, 'ServerAccessLogsBucket', {
        bucketName: `${prefix}-data-retention-server-access-logs`.toLowerCase(),
        encryption: BucketEncryption.S3_MANAGED,
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        versioned: true,
        objectLockDefaultRetention: getS3ObjectLockRetention(s3ObjectLock, dataExpirationInYears),
        autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
        removalPolicy: removalPolicy,
        lifecycleRules:
          dataExpirationInYears === 0
            ? []
            : [
                {
                  id: 'DataExpirationPolicy',
                  enabled: true,
                  prefix: 'server-access-logs/',
                  expiration: Duration.days(dataExpirationInYears * 365)
                }
              ]
      });

      NagSuppressions.addResourceSuppressions(this.serverAccessBucket, [
        { id: 'NIST.800.53.R5-S3DefaultEncryptionKMS', reason: 'S3 Server Access Logs Bucket do not support KMS-C keys' }
      ]);
    }

    this.dataBucket = new Bucket(this, 'Bucket', {
      encryptionKey: this.infraKey,
      bucketName: `${prefix}-data-retention`.toLowerCase(),
      serverAccessLogsBucket: this.serverAccessBucket,
      serverAccessLogsPrefix: this.serverAccessBucket ? 'server-access-logs/' : undefined,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectLockDefaultRetention: getS3ObjectLockRetention(s3ObjectLock, dataExpirationInYears),
      autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
      removalPolicy: removalPolicy,
      lifecycleRules:
        dataExpirationInYears === 0
          ? []
          : [
              {
                id: 'DataExpirationPolicy',
                enabled: true,
                prefix: 'data/',
                expiration: Duration.days(dataExpirationInYears * 365)
              }
            ]
    });

    this.wickrSecret = new Secret(this, 'Secret', {
      secretName: `${prefix}-data-retention-config`,
      encryptionKey: this.infraKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          password: 'REPLACE-ME-AFTER-DEPLOYMENT',
          s3_folder_name: 'data/',
          s3_bucket_name: this.dataBucket.bucketName,
          s3_region: this.region,
          kms_master_key_arn: this.dataKey.keyArn,
          kms_region: this.region
        }),
        generateStringKey: 'unused'
      }
    });

    this.ecsConfigSecret = new Secret(this, 'ECSSecret', {
      secretName: `${prefix}-ecs-env-config`,
      encryptionKey: this.infraKey,
      removalPolicy: removalPolicy,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          WICKRIO_COMP_TIMEROTATE: wickrCompTimeRotation.toString(),
          WICKRIO_METRICS_TYPE: 'cloudwatch',
          WICKRIO_BOT_NAME: wickrBotName,
          AWS_SECRET_REGION: this.region,
          AWS_DEFAULT_REGION: this.region,
          AWS_USE_FIPS_ENDPOINT: this.region.match('(us|ca).*') ? 'true' : 'false',
          AWS_SECRET_NAME: this.wickrSecret.secretName
        }),
        generateStringKey: 'unused'
      }
    });

    this.efsSG = new SecurityGroup(this, 'EFS-SG', { vpc, allowAllOutbound: false });
    this.ecsSG = new SecurityGroup(this, 'ECS-SG', { vpc, description: 'ECS-SG', allowAllOutbound: false });

    this.efsSG.addIngressRule(this.ecsSG, Port.tcp(2049), 'Allow EFS access from Wickr Data Retention ECS Tasks');
    this.efsSG.addEgressRule(this.ecsSG, Port.tcp(2049), 'Allow EFS responses back to ECS tasks');

    this.ecsSG.addEgressRule(this.efsSG, Port.tcp(2049), 'Allow ECS to EFS communication');
    this.ecsSG.addEgressRule(Peer.anyIpv4(), Port.tcp(443), 'Allow HTTPS Outbound');

    this.efs = new FileSystem(this, 'EFS', {
      vpc,
      fileSystemName: `${prefix}-data-retention-efs`,
      vpcSubnets: subnetFilter,
      encrypted: true,
      kmsKey: this.infraKey,
      performanceMode: efsPerformanceMode,
      throughputMode: efsThroughputMode,
      securityGroup: this.efsSG,
      enableAutomaticBackups: efsEnableAutomaticBackups
    });

    this.efs.addToResourcePolicy(
      new PolicyStatement({
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ['*'],
        conditions: {
          Bool: {
            'aws:SecureTransport': 'false'
          }
        }
      })
    );

    this.createSmAccessAlarm(prefix, this.infraKey, [this.ecsConfigSecret, this.wickrSecret]);
  }

  private createSmAccessAlarm(prefix: string, infraKey: Key, secretArns: Secret[]) {
    const name = `${prefix}-secrets-manager-accessed`;
    new CfnRule(this, 'SecretAccessedAlarmRule', {
      name: name,
      eventPattern: {
        'detail-type': ['AWS API Call via CloudTrail'],
        source: ['aws.secretsmanager'],
        detail: {
          eventSource: ['secretsmanager.amazonaws.com'],
          eventName: ['GetSecretValue'],
          requestParameters: {
            secretId: secretArns.map((secret) => secret.secretArn)
          }
        }
      },
      state: 'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS'
    });

    new Alarm(this, 'SecretAccessedAlarm', {
      metric: new Metric({
        namespace: 'AWS/Events',
        metricName: 'MatchedEvents',
        dimensionsMap: {
          RuleName: `${prefix}-secrets-manager-accessed-rule`
        },
        period: Duration.minutes(1),
        statistic: 'Sum'
      }),
      threshold: 1,
      evaluationPeriods: 1,
      alarmName: name,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
    });
  }
}

const getS3ObjectLockRetention = (lockMode: S3ObjectLock, dataExpirationInYears: number) => {
  if (lockMode === false) return undefined;

  const retentionDays = Duration.days(dataExpirationInYears * 365);
  return lockMode === 'compliance' ? ObjectLockRetention.compliance(retentionDays) : ObjectLockRetention.governance(retentionDays);
};
