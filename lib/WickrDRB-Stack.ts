import { Construct } from 'constructs';
import { Stack, CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Vpc, SubnetFilter, SecurityGroup, IVpc, Peer, Port } from 'aws-cdk-lib/aws-ec2';
import { Role, ServicePrincipal, PolicyStatement, PolicyDocument, ManagedPolicy } from 'aws-cdk-lib/aws-iam';
import {
  Cluster,
  FargateService,
  FargateTaskDefinition,
  ContainerImage,
  LogDrivers,
  Secret as ECSSecret,
  ContainerInsights
} from 'aws-cdk-lib/aws-ecs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Key } from 'aws-cdk-lib/aws-kms';
import { FileSystem, AccessPoint } from 'aws-cdk-lib/aws-efs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { NagSuppressions } from 'cdk-nag';

import config from '../bin/config';
import { WickrDRBStackProps } from '../types/stack';

export class WickrDRBStack extends Stack {
  constructor(scope: Construct, id: string, props: WickrDRBStackProps) {
    super(scope, id, props);

    if (!props?.env?.account || !props?.env?.region) {
      throw new Error('Stack must have env.account and env.region for VPC lookup');
    }

    const { dataBucket, efs, wickrSecret, ecsConfigSecret, ecsSG, infraKey, dataKey } = props;
    const {
      prefix,
      vpcId,
      subnetIds,
      removalPolicy,
      dataExpirationInYears,
      containerImageUri,
      ecsMemory,
      ecsCpu,
      ecsContainerInsights,
      wickrBotName
    } = config;

    const vpc = Vpc.fromLookup(this, 'VPC', { vpcId });
    const subnetFilter = { subnetFilters: [SubnetFilter.byIds(subnetIds)] };

    // Create resources
    const { accessPoint } = this.createInfrastructure(efs, wickrBotName);
    const { ecslogGroup, service } = this.createECSResources(
      vpc,
      ecsContainerInsights,
      accessPoint,
      efs,
      dataBucket,
      wickrSecret,
      ecsConfigSecret,
      ecsSG,
      infraKey,
      dataKey,
      subnetFilter,
      prefix,
      containerImageUri,
      ecsMemory,
      ecsCpu,
      wickrBotName,
      removalPolicy,
      dataExpirationInYears
    );
    this.createPostDeployResources(
      vpc,
      subnetFilter,
      infraKey,
      prefix,
      dataExpirationInYears,
      removalPolicy,
      ecslogGroup,
      wickrSecret,
      dataBucket,
      service
    );
  }

  private createInfrastructure(efs: FileSystem, wickrBotName: string) {
    const accessPoint = new AccessPoint(this, 'EFS-AccessPoint', {
      fileSystem: efs,
      path: `/opt/${wickrBotName}`,
      createAcl: { ownerGid: '1000', ownerUid: '1000', permissions: '755' }
    });

    return { accessPoint };
  }

  private createExecutionRole(ecsConfigSecret: Secret, logGroup: LogGroup, infrakey: Key) {
    return new Role(this, 'ExecutionRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
        new ManagedPolicy(this, 'ExecutionPolicy', {
          document: new PolicyDocument({
            statements: [
              new PolicyStatement({
                actions: ['secretsmanager:GetSecretValue'],
                resources: [`${ecsConfigSecret.secretArn}*`]
              }),
              new PolicyStatement({
                actions: ['kms:GenerateDataKey', 'kms:Decrypt', 'kms:DescribeKey'],
                resources: [infrakey.keyArn]
              }),
              new PolicyStatement({
                actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`]
              })
            ]
          })
        })
      ]
    });
  }

  private createTaskRole(
    dataBucket: Bucket,
    wickrSecret: Secret,
    ecsConfigSecret: Secret,
    dataKey: Key,
    infraKey: Key,
    logGroup: LogGroup,
    efs: FileSystem,
    accessPoint: AccessPoint
  ) {
    return new Role(this, 'TaskRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        new ManagedPolicy(this, 'TaskPolicy', {
          document: new PolicyDocument({
            statements: [
              new PolicyStatement({
                actions: ['secretsmanager:GetSecretValue'],
                resources: [`${wickrSecret.secretArn}*`, `${ecsConfigSecret.secretArn}*`]
              }),
              new PolicyStatement({
                actions: ['s3:ListBucket', 's3:PutObject'],
                resources: [dataBucket.bucketArn, dataBucket.arnForObjects('data/*'), dataBucket.arnForObjects('bot_public_key.txt')]
              }),
              new PolicyStatement({
                actions: ['kms:GenerateDataKey', 'kms:Decrypt', 'kms:DescribeKey'],
                resources: [dataKey.keyArn, infraKey.keyArn]
              }),
              new PolicyStatement({
                actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                resources: [logGroup.logGroupArn]
              }),
              new PolicyStatement({
                actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
                resources: [efs.fileSystemArn, accessPoint.accessPointArn]
              }),
              new PolicyStatement({
                actions: ['cloudwatch:PutMetricData'],
                resources: ['*'],
                conditions: { StringEquals: { 'cloudwatch:namespace': 'WickrIO' } }
              })
            ]
          })
        })
      ]
    });
  }

  private createECSResources(
    vpc: IVpc,
    ecsContainerInsights: ContainerInsights,
    accessPoint: AccessPoint,
    efs: FileSystem,
    dataBucket: Bucket,
    wickrSecret: Secret,
    ecsConfigSecret: Secret,
    ecsSG: SecurityGroup,
    infraKey: Key,
    dataKey: Key,
    subnetFilter: {
      subnetFilters: SubnetFilter[];
    },
    prefix: string,
    containerImageUri: string,
    ecsMemory: number,
    ecsCpu: number,
    wickrBotName: string,
    removalPolicy: RemovalPolicy,
    dataExpirationInYears: number
  ) {
    const ecslogGroup = new LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${prefix}/task-logs`,
      encryptionKey: infraKey,
      retention: getCloudWatchLogRetention(dataExpirationInYears),
      removalPolicy
    });

    const cluster = new Cluster(this, 'Cluster', { vpc, containerInsightsV2: ecsContainerInsights });
    const taskRole = this.createTaskRole(dataBucket, wickrSecret, ecsConfigSecret, dataKey, infraKey, ecslogGroup, efs, accessPoint);
    const executionRole = this.createExecutionRole(ecsConfigSecret, ecslogGroup, infraKey);

    const taskDefinition = new FargateTaskDefinition(this, 'FargateTaskDefinition', {
      taskRole,
      executionRole,
      family: `${prefix}-task-definition`,
      cpu: ecsCpu,
      memoryLimitMiB: ecsMemory,
      volumes: [
        {
          name: 'efs',
          efsVolumeConfiguration: {
            fileSystemId: efs.fileSystemId,
            transitEncryption: 'ENABLED',
            authorizationConfig: { accessPointId: accessPoint.accessPointId, iam: 'ENABLED' }
          }
        }
      ]
    });

    const container = taskDefinition.addContainer('Container', {
      image: ContainerImage.fromRegistry(containerImageUri),
      memoryLimitMiB: ecsMemory,
      cpu: ecsCpu,
      logging: LogDrivers.awsLogs({ streamPrefix: 'wickr-drb', logGroup: ecslogGroup }),
      secrets: createECSSecrets(this, ecsConfigSecret),
      essential: true
    });

    container.addMountPoints({
      sourceVolume: 'efs',
      containerPath: `/tmp/${wickrBotName}`,
      readOnly: false
    });

    const service = new FargateService(this, 'FargateService', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      securityGroups: [ecsSG],
      vpcSubnets: subnetFilter,
      enableExecuteCommand: true,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true }
    });

    return { cluster, service, ecslogGroup };
  }

  private createPostDeployResources(
    vpc: IVpc,
    subnetFilter: {
      subnetFilters: SubnetFilter[];
    },
    infraKey: Key,
    prefix: string,
    dataExpirationInYears: number,
    removalPolicy: RemovalPolicy,
    logGroup: LogGroup,
    wickrSecret: Secret,
    dataBucket: Bucket,
    service: FargateService
  ) {
    const postDeployLogGroup = new LogGroup(this, 'LambdaLogGroup', {
      logGroupName: `/aws/lambda/${prefix}-post-deploy-lambda`,
      encryptionKey: infraKey,
      retention: getCloudWatchLogRetention(dataExpirationInYears),
      removalPolicy
    });

    const sg = new SecurityGroup(this, 'PostDeployLambda-SG', { vpc, allowAllOutbound: false });
    sg.addEgressRule(Peer.anyIpv4(), Port.tcp(443), 'Allow HTTPS Outbound');

    const postDeployLambda = new Function(this, 'PostDeployLambda', {
      runtime: Runtime.PYTHON_3_13,
      functionName: `${prefix}-post-deploy-lambda`,
      logGroup: postDeployLogGroup,
      role: new Role(this, 'LambdaPostDeployRole', {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
          new ManagedPolicy(this, 'LambdaPolicy', {
            document: new PolicyDocument({
              statements: [
                new PolicyStatement({
                  actions: ['logs:DescribeLogStreams', 'logs:GetLogEvents', 'logs:DeleteLogStream', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                  resources: [
                    logGroup.logGroupArn,
                    `${logGroup.logGroupArn}:*`,
                    postDeployLogGroup.logGroupArn,
                    `${postDeployLogGroup.logGroupArn}:*`
                  ]
                }),
                new PolicyStatement({
                  actions: ['secretsmanager:GetSecretValue', 'secretsmanager:UpdateSecret'],
                  resources: [wickrSecret.secretArn]
                }),
                new PolicyStatement({
                  actions: ['s3:PutObject'],
                  resources: [dataBucket.arnForObjects('bot_public_key.txt')]
                }),
                new PolicyStatement({
                  actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
                  resources: [infraKey.keyArn]
                })
              ]
            })
          })
        ]
      }),
      handler: 'post_deploy.lambda_handler',
      timeout: Duration.minutes(5),
      reservedConcurrentExecutions: 1,
      environment: {
        LOG_GROUP_NAME: logGroup.logGroupName,
        SECRET_ARN: wickrSecret.secretArn,
        BUCKET_NAME: dataBucket.bucketName,
        KMS_KEY_ID: infraKey.keyId
      },
      environmentEncryption: infraKey,
      vpc,
      vpcSubnets: subnetFilter,
      securityGroups: [sg],
      code: Code.fromAsset('lib/lambda')
    });

    postDeployLambda.node.addDependency(postDeployLogGroup);

    const providerLogGroup = new LogGroup(this, 'LambdaCRLogGroup', {
      logGroupName: `/aws/lambda/${prefix}-cr-provider`,
      encryptionKey: infraKey,
      retention: getCloudWatchLogRetention(dataExpirationInYears),
      removalPolicy
    });

    const provider = new Provider(this, 'PostDeployProvider', {
      onEventHandler: postDeployLambda,
      vpc,
      vpcSubnets: subnetFilter,
      providerFunctionEnvEncryption: infraKey,
      logGroup: providerLogGroup
    });

    new CustomResource(this, 'PostDeployTrigger', {
      serviceToken: provider.serviceToken
    });

    provider.node.addDependency(service);
    provider.node.addDependency(logGroup);

    NagSuppressions.addResourceSuppressions(
      provider,
      [
        {
          id: 'NIST.800.53.R5-LambdaConcurrency',
          reason: 'Lambda concurrency is not required for because this orchastrates the actual custom resource lambda'
        }
      ],
      true
    );
  }
}

// Helper functions
function getCloudWatchLogRetention(years: number): RetentionDays {
  switch (years) {
    case 0:
      return RetentionDays.INFINITE;
    case 1:
      return RetentionDays.ONE_YEAR;
    case 5:
      return RetentionDays.FIVE_YEARS;
    case 10:
      return RetentionDays.TEN_YEARS;
    default:
      return RetentionDays.TWO_YEARS;
  }
}

function createECSSecrets(scope: Construct, ecsConfigSecret: Secret) {
  const secretKeys = [
    'WICKRIO_COMP_TIMEROTATE',
    'WICKRIO_METRICS_TYPE',
    'WICKRIO_BOT_NAME',
    'AWS_SECRET_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_USE_FIPS_ENDPOINT',
    'AWS_SECRET_NAME'
  ];

  return secretKeys.reduce((secrets, key) => {
    secrets[key] = ECSSecret.fromSecretsManager(
      Secret.fromSecretAttributes(scope, key, {
        secretPartialArn: ecsConfigSecret.secretArn
      }),
      key
    );
    return secrets;
  }, {} as Record<string, ECSSecret>);
}
