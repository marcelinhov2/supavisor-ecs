import * as cdk from 'aws-cdk-lib/core'
import {
    aws_ec2 as ec2,
    aws_elasticloadbalancingv2 as elbv2,
    aws_ecs as ecs,
    aws_ecr as ecr,
    aws_iam as iam,
    aws_certificatemanager as acm,
    aws_servicediscovery as servicediscovery,
    aws_ecr_assets as assets,
    aws_rds as rds,
    IgnoreMode,
    SecretValue
} from "aws-cdk-lib";

import { Construct } from "constructs";

interface ServiceProps extends cdk.NestedStackProps {
    prefix: string;
    version: string;
    ecsLogDriver: ecs.LogDriver;
    repository: string;
    serviceName: string;
    cluster: ecs.ICluster;
    clusterRds: rds.DatabaseCluster;
    vpc: ec2.IVpc;
    publicSubnets: ec2.SelectedSubnets;
    dockerAssets: assets.DockerImageAsset;
    healthCheckGracePeriod?: cdk.Duration;
}

class Service extends cdk.NestedStack {
    service: ecs.FargateService;
    constructor(scope: Construct, id: string, props: ServiceProps) {
        super(scope, id, props);

        const containerPort = parseInt(this.node.tryGetContext("API_PORT"));
        const proxyPortTransactionPort = parseInt(this.node.tryGetContext("PROXY_PORT_TRANSACTION"));
        const proxyPortSessionPort = parseInt(this.node.tryGetContext("PROXY_PORT_SESSION"));

        const taskrole = new iam.Role(this, "ecsTaskExecutionRole", {
            assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        });
      
        taskrole.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName(
              "service-role/AmazonECSTaskExecutionRolePolicy"
            )
        );

        const fargateTaskDefinition = new ecs.FargateTaskDefinition(this, `${props.prefix}TaskDefinition`, {
            memoryLimitMiB: 512,
            cpu: 256,
            taskRole: taskrole,
        });

        const container = fargateTaskDefinition.addContainer(`${props.prefix}Container`, {
            image: ecs.ContainerImage.fromDockerImageAsset(props.dockerAssets),
            logging: props.ecsLogDriver,
            ulimits: [{
                hardLimit: 100000,
                softLimit: 1024,
                name: ecs.UlimitName.RSS,
            }],
            environment: {
                RELEASE_COOKIE: this.node.tryGetContext("RELEASE_COOKIE"),
                SERVICE_DISCOVERY_ENDPOINT: `${props.prefix}-discovery-service.${props.serviceName}-ns`,
                //##### connect all instances of all services
                //NODE_NAME: 'supavisor',
                //NODE_NAME_QUERY: 'supavisor',
                //##### connect only instances within a service
                NODE_NAME: `${props.serviceName}-supavisor`,
                NODE_NAME_QUERY: `${props.serviceName}-supavisor`,
                PORT: `${containerPort}`,
                PROXY_PORT_SESSION: `${proxyPortSessionPort}`,
                PROXY_PORT_TRANSACTION: `${proxyPortTransactionPort}`,
                DATABASE_URL: `ecto://${props.clusterRds.secret!.secretValueFromJson("username").toString()}:${props.clusterRds.secret!.secretValueFromJson("password").toString()}@${props.clusterRds.secret!.secretValueFromJson("host").toString()}:${props.clusterRds.secret!.secretValueFromJson("port").toString()}/${props.clusterRds.secret!.secretValueFromJson("dbname").toString()}`,
                CLUSTER_POSTGRES: "true",
                SECRET_KEY_BASE: this.node.tryGetContext("SECRET_KEY_BASE"),
                VAULT_ENC_KEY: this.node.tryGetContext("VAULT_ENC_KEY"),
                API_JWT_SECRET: this.node.tryGetContext("API_JWT_SECRET"),
                METRICS_JWT_SECRET: this.node.tryGetContext("METRICS_JWT_SECRET"),
                REGION: "local",
                ERL_AFLAGS: "-proto_dist inet_tcp",
                LANG: "en_US.UTF-8",
                LANGUAGE: "en_US:en",
                LC_ALL: "en_US.UTF-8",
            },
            ...(!props.healthCheckGracePeriod && {
                healthCheck: {
                    command: ["CMD-SHELL", "exit 0"],
                    timeout: cdk.Duration.seconds(10),
                    startPeriod: cdk.Duration.seconds(10),
                }
            }),
        });
        container.addPortMappings(
            { 
                containerPort: proxyPortTransactionPort,
                hostPort: proxyPortTransactionPort,
                protocol: ecs.Protocol.TCP,
            }
        );
        container.addPortMappings(
            { 
                containerPort: proxyPortSessionPort,
                hostPort: proxyPortSessionPort,
                protocol: ecs.Protocol.TCP,
            }
        );
        container.addPortMappings({ containerPort });

        const serviceSecGrp = new ec2.SecurityGroup(
            this,
            `${props.serviceName}ServiceSecurityGroup`,
            {
                allowAllOutbound: true,
                securityGroupName: `${props.serviceName}ServiceSecurityGroup`,
                vpc: props.vpc,
            }
        );
      
        serviceSecGrp.connections.allowFromAnyIpv4(ec2.Port.tcp(containerPort));
        serviceSecGrp.connections.allowFromAnyIpv4(ec2.Port.tcp(proxyPortSessionPort));
        serviceSecGrp.connections.allowFromAnyIpv4(ec2.Port.tcp(proxyPortTransactionPort));

        const dnsNamespace = new servicediscovery.PrivateDnsNamespace(
            this,
            `${props.serviceName}DnsNamespace`,
            {
              name: `${props.serviceName}-ns`,
              vpc: props.vpc,
              description: "Private DnsNamespace for my Microservices",
            }
        );

        this.service = new ecs.FargateService(this, `${props.serviceName}Service`, {
            ...(props.healthCheckGracePeriod && {healthCheckGracePeriod: props.healthCheckGracePeriod}),
            cluster: props.cluster,
            vpcSubnets: props.publicSubnets,
            securityGroups: [serviceSecGrp],
            assignPublicIp: true,
            serviceName: `${props.prefix}-service-${props.serviceName}`,
            propagateTags: ecs.PropagatedTagSource.SERVICE,
            taskDefinition: fargateTaskDefinition,
            desiredCount: parseInt(this.node.tryGetContext("FARGATE_TASK_DESIRED_COUNT")),
            enableExecuteCommand: true,
            circuitBreaker: { rollback: true },
            cloudMapOptions: {
                name: props.serviceName,
                dnsRecordType: servicediscovery.DnsRecordType.A,
                dnsTtl: cdk.Duration.seconds(10),
                cloudMapNamespace: dnsNamespace,
            }
        });
    }
}

interface AppResourcesProps extends cdk.NestedStackProps {
    vpc: ec2.IVpc;
    prefix: string;
    ecsLogDriver: ecs.LogDriver;
    supavisorServiceVersion: string;
    repository: string;
    publicSubnets: ec2.SelectedSubnets;
    clusterRds: rds.DatabaseCluster;
    certificate: acm.Certificate;
}
export class AppResources extends cdk.NestedStack {
    supavisorService: ecs.FargateService;
    loadBalancer: elbv2.ApplicationLoadBalancer;
    networkLoadBalancer: elbv2.NetworkLoadBalancer;

    constructor(scope: Construct, id: string, props: AppResourcesProps) {
        super(scope, id, props);

        const containerPort = parseInt(this.node.tryGetContext("API_PORT"));
        const proxyPortTransactionPort = parseInt(this.node.tryGetContext("PROXY_PORT_TRANSACTION"));
        const proxyPortSessionPort = parseInt(this.node.tryGetContext("PROXY_PORT_SESSION"));

        const { cluster } = this.createBaseResources(props);

        this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'SupavisorLb', {
            vpc: props.vpc,
            internetFacing: true,
            loadBalancerName: `${props.prefix}-load-balancer`,
        });
        this.networkLoadBalancer = new elbv2.NetworkLoadBalancer(this, 'SupavisorNlb', {
            vpc: props.vpc,
            internetFacing: true,
            loadBalancerName: `${props.prefix}-network-load-balancer`,
            securityGroups: [new ec2.SecurityGroup(this, 'LoadBalancerSG', { vpc: props.vpc, allowAllOutbound: true })]
        });
        const listener = this.loadBalancer.addListener('Listener', { port: 443, protocol: elbv2.ApplicationProtocol.HTTPS, certificates: [props.certificate] });
        const listener5452 = this.networkLoadBalancer.addListener('Listener5452', { port: proxyPortSessionPort });
        const listener6543 = this.networkLoadBalancer.addListener('Listener6543', { port: proxyPortTransactionPort });

        const dockerSupavisorAsset = new assets.DockerImageAsset(
            this,
            'SupavisorImage',
            {
                directory: '../supavisor/',
            }
        );

        this.supavisorService = new Service(this, 'supavisorService', {
            prefix: props.prefix,
            version: props.supavisorServiceVersion,
            ecsLogDriver: props.ecsLogDriver,
            repository: props.repository,
            serviceName: 'supavisor-service',
            cluster,
            dockerAssets: dockerSupavisorAsset,
            clusterRds: props.clusterRds,
            vpc: props.vpc,
            publicSubnets: props.publicSubnets,
            healthCheckGracePeriod: cdk.Duration.seconds(20),
        }).service;

        this.networkLoadBalancer.connections.allowFromAnyIpv4(ec2.Port.tcp(proxyPortSessionPort));
        this.networkLoadBalancer.connections.allowFromAnyIpv4(ec2.Port.tcp(proxyPortTransactionPort));
        this.supavisorService.connections.allowFrom(this.networkLoadBalancer.connections, ec2.Port.allTraffic());

        this.connectServices(props);

        const supavisorTargetGroup = listener.addTargets('supavisorTarget', {
            port: containerPort,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targets: [this.supavisorService.loadBalancerTarget({
                containerName: `${props.prefix}Container`,
                containerPort: containerPort,
            })],
            healthCheck: {
                path: '/swaggerui',
                protocol: elbv2.Protocol.HTTP,
                interval: cdk.Duration.seconds(30),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 5,
            },
        });
        supavisorTargetGroup.setAttribute('deregistration_delay.timeout_seconds', '5');

        listener5452.addTargets('postgrestarget', {
            port: proxyPortSessionPort,
            protocol: elbv2.Protocol.TCP,
            targets: [this.supavisorService.loadBalancerTarget({
                containerName: `${props.prefix}Container`,
                containerPort: proxyPortSessionPort,
            })],
            healthCheck: {
                path: '/swaggerui',
                protocol: elbv2.Protocol.HTTP,
                interval: cdk.Duration.seconds(30),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 5,
            },
        });
        
        listener6543.addTargets('postgrestarget', {
            port: proxyPortTransactionPort,
            protocol: elbv2.Protocol.TCP,
            targets: [this.supavisorService.loadBalancerTarget({
                containerName: `${props.prefix}Container`,
                containerPort: proxyPortTransactionPort,
            })],
            healthCheck: {
                path: '/swaggerui',
                protocol: elbv2.Protocol.HTTP,
                interval: cdk.Duration.seconds(30),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 5,
            },
        });

    }

    private createBaseResources(props: AppResourcesProps) {
        const cluster = new ecs.Cluster(this, 'SupavisorCluster', {
            clusterName: `${props.prefix}-cluster`,
            vpc: props.vpc,
        });
    
        return { cluster };
    }

    private connectServices(props: AppResourcesProps) {
        this.supavisorService.connections.allowFrom(
            this.supavisorService,
            ec2.Port.allTcp(),
            `${props.prefix} supavisor to supavisor`,
        );
    }
}
