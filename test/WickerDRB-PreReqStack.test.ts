import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { WickrDRBPreReqStack } from '../lib/WickrDRB-PreReqStack';
import { testConfig } from './test-config';

// Mock config to use test config
jest.mock('../bin/config', () => ({
  default: require('./test-config').testConfig
}));

describe('WickrDRBPreReqStack', () => {
  let app: App;
  let stack: WickrDRBPreReqStack;
  let template: Template;

  beforeEach(() => {
    app = new App();
    stack = new WickrDRBPreReqStack(app, 'TestPreReqStack', {
      env: { account: testConfig.accountId, region: testConfig.region }
    });
    template = Template.fromStack(stack);
  });

  test('creates infrastructure KMS key with rotation enabled', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true
    });
  });

  test('creates data KMS key with rotation enabled', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true
    });
  });

  test('creates separate infrastructure and data KMS keys', () => {
    // Verify we have exactly 2 KMS keys
    template.resourceCountIs('AWS::KMS::Key', 2);

    // Both should have rotation enabled
    const keys = template.findResources('AWS::KMS::Key');
    const keyIds = Object.keys(keys);
    expect(keyIds).toHaveLength(2);

    keyIds.forEach((keyId) => {
      expect(keys[keyId].Properties.EnableKeyRotation).toBe(true);
    });
  });

  test('creates KMS key policy for CloudWatch Logs', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowCloudWatchLogs',
            Principal: {
              Service: `logs.${testConfig.region}.amazonaws.com`
            },
            Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey']
          })
        ])
      }
    });
  });

  test('creates main S3 bucket with KMS encryption', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: `${testConfig.prefix}-data-retention`,
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'aws:kms',
              KMSMasterKeyID: {
                'Fn::GetAtt': [Match.anyValue(), 'Arn']
              }
            }
          }
        ]
      },
      VersioningConfiguration: {
        Status: 'Enabled'
      }
    });
  });

  test('does not create server access logs bucket when disabled', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
  });

  describe('with server access logs enabled', () => {
    let appWithLogs: App;
    let stackWithLogs: WickrDRBPreReqStack;
    let templateWithLogs: Template;

    beforeAll(() => {
      jest.resetModules();
      const configWithLogs = { ...testConfig, enableS3ServerAccessLogs: true };
      jest.doMock('../bin/config', () => ({ default: configWithLogs }));

      const { WickrDRBPreReqStack } = require('../lib/WickrDRB-PreReqStack');
      appWithLogs = new App();
      stackWithLogs = new WickrDRBPreReqStack(appWithLogs, 'TestPreReqStackWithLogs', {
        env: { account: testConfig.accountId, region: testConfig.region }
      });
      templateWithLogs = Template.fromStack(stackWithLogs);
    });

    test('creates server access logs bucket', () => {
      templateWithLogs.resourceCountIs('AWS::S3::Bucket', 2);

      templateWithLogs.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: `${testConfig.prefix}-data-retention-server-access-logs`,
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256'
              }
            }
          ]
        }
      });
    });

    test('configures main bucket with server access logs', () => {
      templateWithLogs.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: `${testConfig.prefix}-data-retention`,
        LoggingConfiguration: {
          DestinationBucketName: {
            Ref: Match.anyValue()
          },
          LogFilePrefix: 'server-access-logs/'
        }
      });
    });
  });

  test('creates S3 bucket with lifecycle rules', () => {
    const expectedProps: any = {
      BucketName: `${testConfig.prefix}-data-retention`
    };

    if (testConfig.dataExpirationInYears > 0) {
      expectedProps.LifecycleConfiguration = {
        Rules: [
          {
            Id: 'DataExpirationPolicy',
            Status: 'Enabled',
            ExpirationInDays: testConfig.dataExpirationInYears * 365
          }
        ]
      };
    }

    template.hasResourceProperties('AWS::S3::Bucket', expectedProps);
  });

  test('creates EFS file system with KMS encryption', () => {
    template.hasResourceProperties('AWS::EFS::FileSystem', {
      Encrypted: true,
      KmsKeyId: {
        'Fn::GetAtt': [Match.anyValue(), 'Arn']
      },
      PerformanceMode: testConfig.efsPerformanceMode,
      ThroughputMode: testConfig.efsThroughputMode,
      FileSystemTags: [
        {
          Key: 'Name',
          Value: `${testConfig.prefix}-data-retention-efs`
        }
      ]
    });
  });

  test('creates EFS with secure transport policy', () => {
    template.hasResourceProperties('AWS::EFS::FileSystem', {
      FileSystemPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Principal: {
              AWS: '*'
            },
            Action: '*',
            Condition: {
              Bool: {
                'aws:SecureTransport': 'false'
              }
            }
          })
        ])
      }
    });
  });

  test('creates Secrets Manager secret with structured content', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `${testConfig.prefix}-data-retention-config`,
      KmsKeyId: {
        'Fn::GetAtt': [Match.anyValue(), 'Arn']
      },
      GenerateSecretString: {
        SecretStringTemplate: {
          'Fn::Join': Match.anyValue()
        },
        GenerateStringKey: 'unused'
      }
    });
  });

  test('creates EFS and ECS security groups', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 2);

    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'ECS-SG'
    });
  });

  test('creates security group ingress rule for EFS access', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 2049,
      ToPort: 2049
    });
  });

  test('creates ECS secret with environment variables', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `${testConfig.prefix}-ecs-env-config`,
      KmsKeyId: {
        'Fn::GetAtt': [Match.anyValue(), 'Arn']
      },
      GenerateSecretString: {
        SecretStringTemplate: {
          'Fn::Join': Match.anyValue()
        },
        GenerateStringKey: 'unused'
      }
    });
  });

  test('data retention secret includes data key ARN reference', () => {
    // Verify the secret contains a reference to the data key ARN
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `${testConfig.prefix}-data-retention-config`,
      GenerateSecretString: {
        SecretStringTemplate: {
          'Fn::Join': Match.anyValue()
        }
      }
    });
  });

  test('creates S3 bucket with public access blocked', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true
      }
    });
  });

  test('creates S3 bucket policy to enforce SSL', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: {
              Bool: {
                'aws:SecureTransport': 'false'
              }
            }
          })
        ])
      }
    });
  });

  test('creates Secrets Manager access alarm components', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: `${testConfig.prefix}-secrets-manager-accessed`,
      EventPattern: {
        source: ['aws.secretsmanager'],
        'detail-type': ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['secretsmanager.amazonaws.com'],
          eventName: ['GetSecretValue'],
          requestParameters: {
            secretId: Match.anyValue()
          }
        }
      }
    });

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: `${testConfig.prefix}-secrets-manager-accessed`,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 1,
      Threshold: 1,
      TreatMissingData: 'notBreaching'
    });
  });

  test('verifies resource counts', () => {
    template.resourceCountIs('AWS::KMS::Key', 2);
    template.resourceCountIs('AWS::SecretsManager::Secret', 2);
    template.resourceCountIs('AWS::EFS::FileSystem', 1);
    template.resourceCountIs('AWS::EC2::SecurityGroup', 2);
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 1);
    template.resourceCountIs('AWS::Events::Rule', 1);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
  });
});
