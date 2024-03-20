import * as cdk from 'aws-cdk-lib/core'
import {
    aws_ec2 as ec2,
    aws_ecs as ecs,
    aws_ecr as ecr,
    aws_cloudfront_origins as origins,
    aws_certificatemanager as acm,
    aws_logs as logs,
    aws_route53 as route53,
    aws_rds as rds,
    aws_route53_targets as route53targets,
    aws_cloudfront as cloudfront,
    aws_lambda as lambda,
    aws_iam as iam,
    custom_resources as cr,
} from "aws-cdk-lib";

import { AppResources } from './app-resources';

import { Construct } from "constructs";

const prefix = 'supavisor-ecs';
const repository = prefix;

export class InfrastructureStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const domain = this.node.tryGetContext("DOMAIN");

        const supavisorVersion = new cdk.CfnParameter(this, 'supavisorVersion', {
            description: 'supavisor service version',
            type: 'String',
            default: 'latest',
        });

        const hostedZone = new route53.PublicHostedZone(this, 'zone', {
            zoneName: domain,
          });

        const certificate = new acm.Certificate(this, 'MainDomainCertificate', {
            domainName: domain,
            validation: acm.CertificateValidation.fromDns(hostedZone),
          });

        const vpc = new ec2.Vpc(this, "vpc", {
            subnetConfiguration: [{
              name: 'public',
              subnetType: ec2.SubnetType.PUBLIC,
            }, {
              name: 'private',
              subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            }],
            maxAzs: 2
        });

        const publicSubnets = vpc.selectSubnets({
            subnetType: ec2.SubnetType.PUBLIC,
            availabilityZones: ["us-east-1a", "us-east-1b"],
        });
    
        //The printout here is same as aws console
        publicSubnets.subnets.forEach((subnet) => {
            console.log("==>>subnetId:" + subnet.subnetId + "\n");
        });

        const logGroup = new logs.LogGroup(this, 'LogGroup', {
            retention: logs.RetentionDays.ONE_DAY,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            logGroupName: `${prefix}-log-group`,
        });
        const ecsLogDriver = ecs.LogDrivers.awsLogs({
            logGroup,
            streamPrefix: `${prefix}-logs`,
        });
        new ecr.Repository(this, repository, {
            repositoryName: repository,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            imageTagMutability: ecr.TagMutability.MUTABLE,
        });

        const clusterRdsSecurityGroup = new ec2.SecurityGroup(this, 'AuroraSecurityGroup', {
            vpc: vpc,
            allowAllOutbound: true, // Adjust based on your security requirements
        });
    
        // Allow inbound connections to the Aurora cluster port (default PostgreSQL port 5432)
        clusterRdsSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5432), 'Allow inbound PostgreSQL connections');

        const clusterRds = new rds.DatabaseCluster(this, 'Cluster', {
            engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_15_2 }),
            credentials: rds.Credentials.fromGeneratedSecret("postgres"),
            defaultDatabaseName: this.node.tryGetContext("DEFAULT_DATABASE_NAME"),
            writer: rds.ClusterInstance.serverlessV2('writer', {
                publiclyAccessible: false,
            }),
            readers: [
                rds.ClusterInstance.serverlessV2('reader1'),
                rds.ClusterInstance.serverlessV2('reader2'),
                rds.ClusterInstance.serverlessV2('reader3'),
            ],
            serverlessV2MinCapacity: parseInt(this.node.tryGetContext("DB_CLUSTER_MIN")),
            serverlessV2MaxCapacity: parseInt(this.node.tryGetContext("DB_CLUSTER_MAX")),
            vpc: vpc,
            securityGroups: [clusterRdsSecurityGroup]
        });

        initDatabase(this, clusterRds, clusterRdsSecurityGroup, vpc);

        const { loadBalancer, networkLoadBalancer } = new AppResources(this, 'app', {
            prefix,
            ecsLogDriver,
            vpc,
            publicSubnets,
            supavisorServiceVersion: supavisorVersion.valueAsString,
            repository,
            clusterRds,
            certificate
        });

        loadBalancer.node.addDependency(clusterRds);

        const domainARecord = new route53.ARecord(this, "Alias", {
            zone: hostedZone,
            recordName: domain,
            target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(loadBalancer)),
        });

        const domainPgARecord = new route53.ARecord(this, "NLBARecord", {
            zone: hostedZone,
            recordName: `pool.${domain}`,
            target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(networkLoadBalancer)),
        });

        new cdk.CfnOutput(this, 'OutputName', {
            value: loadBalancer.loadBalancerDnsName,
            description: 'load balancer url',
            exportName: `${prefix}-lb-url`,
        });

        new cdk.CfnOutput(this, 'Database Host', {
            value: clusterRds.secret!.secretValueFromJson("host").toString(),
            description: 'RDS url',
            exportName: `${prefix}-rds-host`,
        });
    }
}

function initDatabase(
    stack: cdk.Stack,
    database: rds.DatabaseCluster,
    dbSecurityGroup: ec2.SecurityGroup,
    vpc: ec2.IVpc,
  ) {
    const lambdaRole = new iam.Role(stack, 'initDBLambdaRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    lambdaRole.addManagedPolicy(
        iam.ManagedPolicy.fromManagedPolicyArn(
            stack,
            'lambdavpcaccesspolicy',
            'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
        ),
    );
    lambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'));
    lambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess')); //TODO !!!
  
    const initDBSecurityGroup = new ec2.SecurityGroup(stack, 'initDBSecurityGroup', {
        vpc,
        securityGroupName: `stack-init-db-sg`,
        description: 'Enable HTTP access via port 5432',
    });
  
    const onEvent = new lambda.Function(stack, 'InitDBHandler', {
        runtime: lambda.Runtime.NODEJS_20_X,
        vpc,
        code: lambda.Code.fromAsset('lib/lambda'),
        handler: 'index.handler',
        logRetention: logs.RetentionDays.ONE_DAY,
        timeout: cdk.Duration.minutes(5),
        role: lambdaRole,
        securityGroups: [initDBSecurityGroup],
        allowPublicSubnet: true,
        environment: {
            DATABASE_URL: `postgresql://${database.secret!.secretValueFromJson("username").toString()}:${database.secret!.secretValueFromJson("password").toString()}@${database.secret!.secretValueFromJson("host").toString()}:${database.secret!.secretValueFromJson("port").toString()}/${database.secret!.secretValueFromJson("dbname").toString()}`,
        }
    });
  
    const role = new iam.Role(stack, 'initDBRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AWSLambda_FullAccess'));
  
    const provider = new cr.Provider(stack, 'dbInitProvider', {
        onEventHandler: onEvent,
        logRetention: logs.RetentionDays.ONE_DAY,
        role,
    });
  
    const dbInit = new cdk.CustomResource(stack, 'databaseInit', {
        serviceToken: provider.serviceToken,
        properties: {
            host: database.secret!.secretValueFromJson("host").toString(),
            //random: `${Math.random()}`, //help to trigger event every time
        },
    });
    dbInit.node.addDependency(database);
    dbSecurityGroup.connections.allowFrom(
        onEvent,
        ec2.Port.tcp(5432),
        `my stack lambda intidb ingress 5432`,
    );
  }
  