import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { FileSystem } from 'aws-cdk-lib/aws-efs';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { WickrDRBStack } from '../lib/WickrDRB-Stack';

import { testConfig } from './test-config';

// Mock config to use test config
jest.mock('../bin/config', () => ({
  default: require('./test-config').testConfig
}));

describe('WickrDRBStack', () => {
  let app: App;
  let stack: WickrDRBStack;
  let template: Template;

  beforeEach(() => {
    app = new App();

    // Create mock dependencies with env
    const mockStack = new Stack(app, 'MockStack', {
      env: { account: testConfig.accountId, region: testConfig.region }
    });
    const vpc = Vpc.fromLookup(mockStack, 'MockVpc', { vpcId: 'vpc-12345' });

    const mockBucket = new Bucket(mockStack, 'MockBucket');
    const mockKey = new Key(mockStack, 'MockKey');
    const mockEfs = new FileSystem(mockStack, 'MockEfs', { vpc });
    const mockSecret = new Secret(mockStack, 'MockSecret');
    const mockEcsSecret = new Secret(mockStack, 'MockEcsSecret');
    const mockEfsSG = new SecurityGroup(mockStack, 'MockEfsSG', { vpc });
    const mockEcsSG = new SecurityGroup(mockStack, 'MockEcsSG', { vpc });

    stack = new WickrDRBStack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      dataBucket: mockBucket,
      efs: mockEfs,
      wickrSecret: mockSecret,
      ecsConfigSecret: mockEcsSecret,
      efsSG: mockEfsSG,
      ecsSG: mockEcsSG,
      infraKey: mockKey,
      dataKey: mockKey
    });

    template = Template.fromStack(stack);
  });

  test('creates EFS Access Point with correct configuration', () => {
    template.hasResourceProperties('AWS::EFS::AccessPoint', {
      RootDirectory: {
        Path: `/opt/${testConfig.wickrBotName}`,
        CreationInfo: {
          OwnerGid: '1000',
          OwnerUid: '1000',
          Permissions: '755'
        }
      }
    });
  });

  test('creates IAM task role with comprehensive permissions', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'ecs-tasks.amazonaws.com' }
          }
        ]
      },
      ManagedPolicyArns: Match.arrayWith([{ Ref: Match.anyValue() }])
    });
  });

  test('creates CloudWatch log group with encryption', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: `/ecs/${testConfig.prefix}/task-logs`,
      RetentionInDays: 365,
      KmsKeyId: {
        'Fn::ImportValue': Match.anyValue()
      }
    });
  });

  test('creates ECS cluster with container insights', () => {
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterSettings: [
        {
          Name: 'containerInsights',
          Value: 'enabled'
        }
      ]
    });
  });

  test('creates Fargate task definition with EFS volume', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      RequiresCompatibilities: ['FARGATE'],
      Cpu: testConfig.ecsCpu.toString(),
      Memory: testConfig.ecsMemory.toString(),
      NetworkMode: 'awsvpc',
      Family: `${testConfig.prefix}-task-definition`,
      Volumes: [
        {
          Name: 'efs',
          EFSVolumeConfiguration: {
            TransitEncryption: 'ENABLED',
            AuthorizationConfig: {
              IAM: 'ENABLED'
            }
          }
        }
      ]
    });
  });

  test('creates Fargate service with circuit breaker', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      LaunchType: 'FARGATE',
      DesiredCount: 1,
      EnableExecuteCommand: true,
      DeploymentConfiguration: {
        MinimumHealthyPercent: 0,
        MaximumPercent: 100,
        DeploymentCircuitBreaker: {
          Enable: true,
          Rollback: true
        }
      }
    });
  });

  test('creates container with secrets and mount points', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        {
          Secrets: Match.arrayWith([Match.objectLike({ Name: Match.anyValue() })]),
          MountPoints: [
            {
              SourceVolume: 'efs',
              ContainerPath: `/tmp/${testConfig.wickrBotName}`,
              ReadOnly: false
            }
          ]
        }
      ]
    });
  });

  test('creates Lambda function for post-deployment', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.13',
      Handler: 'post_deploy.lambda_handler',
      Timeout: 300,
      KmsKeyArn: {
        'Fn::ImportValue': Match.anyValue()
      }
    });
  });

  test('creates custom resource with provider', () => {
    template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      ServiceToken: {
        'Fn::GetAtt': [Match.anyValue(), 'Arn']
      }
    });
  });

  test('creates Lambda execution role with managed policies', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' }
          }
        ]
      },
      ManagedPolicyArns: Match.arrayWith([
        {
          'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole']]
        }
      ])
    });
  });

  test('creates Lambda policies', () => {
    template.resourceCountIs('AWS::IAM::Policy', 3);
  });

  test('creates execution role for ECS tasks', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'ecs-tasks.amazonaws.com' }
          }
        ]
      },
      ManagedPolicyArns: Match.arrayWith([
        {
          'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy']]
        }
      ])
    });
  });

  test('creates multiple log groups with encryption', () => {
    template.resourceCountIs('AWS::Logs::LogGroup', 3);

    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: `/aws/lambda/${testConfig.prefix}-post-deploy-lambda`,
      RetentionInDays: 365,
      KmsKeyId: {
        'Fn::ImportValue': Match.anyValue()
      }
    });
  });

  test('creates Lambda with VPC configuration and security group', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      VpcConfig: {
        SubnetIds: Match.anyValue(),
        SecurityGroupIds: [{ 'Fn::GetAtt': [Match.stringLikeRegexp('PostDeployLambdaSG'), 'GroupId'] }]
      },
      Environment: {
        Variables: Match.objectLike({
          LOG_GROUP_NAME: Match.anyValue(),
          SECRET_ARN: Match.anyValue(),
          BUCKET_NAME: Match.anyValue(),
          KMS_KEY_ID: Match.anyValue()
        })
      }
    });
  });

  test('creates security group for post deploy Lambda', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: Match.stringLikeRegexp('PostDeployLambda-SG'),
      SecurityGroupEgress: [
        {
          CidrIp: '0.0.0.0/0',
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          Description: 'Allow HTTPS Outbound'
        }
      ],
      VpcId: 'vpc-12345'
    });
  });

  test('creates Provider for custom resource', () => {
    template.resourceCountIs('AWS::Lambda::Function', 2);
  });

  test('verifies resource counts', () => {
    template.resourceCountIs('AWS::IAM::Role', 4);
    template.resourceCountIs('AWS::ECS::Cluster', 1);
    template.resourceCountIs('AWS::ECS::Service', 1);
    template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
    template.resourceCountIs('AWS::EFS::AccessPoint', 1);
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
  });

  test('creates task role with managed policy', () => {
    // Verify task role exists with managed policy
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'ecs-tasks.amazonaws.com' }
          }
        ]
      }
    });
  });

  test('lambda environment includes KMS key reference', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          KMS_KEY_ID: Match.anyValue()
        })
      }
    });
  });
});
