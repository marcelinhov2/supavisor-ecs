# CDK Infrastructure for Supavisor - Postgres Connection Pooler
This repository contains AWS Cloud Development Kit (CDK) code to deploy the infrastructure required for Supavisor, a scalable, cloud-native Postgres connection pooler.

## Architecture Diagram
<img width="1719" alt="image" src="https://github.com/marcelinhov2/neverslow.io/assets/232648/93674c0c-4b90-4878-badf-88f4d913b455">

You can find an HTML interactive version of the diagram at ./diagram/index.html

## Prerequisites
Before deploying the infrastructure, make sure you have the following prerequisites set up:

- AWS credentials with appropriate permissions. You need to set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY as GitHub Secrets in your repository settings.
- Domain name registered with a domain provider.
- Nameservers configured at your domain provider's DNS settings. These nameservers needs to be get at Route 53 page on AWS console.

**IMPORTANT:**
If you are on a Mac M1, your deploy probably will not work since the Docker image is going to run in a Linux environment. So I recommend to use the Github Actions directly to avoid any potential problem.

## Deployment Instructions
To deploy the infrastructure, follow these steps:

Clone this repository:
```bash
git clone https://github.com/marcelinhov2/supavisor-ecs

Navigate to the repository directory:
cd supavisor-ecs

Install dependencies:
npm install
cd infrastructure/lib/lambda
npm install

aws configure
Enter your AWS Access Key ID and Secret Access Key when prompted.

Set up your domain name in the InfrastructureStack.ts file:
const domain = "<your_domain_name>";

Deploy the infrastructure:
STAGE=<stage_name> npm run build && cdk bootstrap && cdk deploy

This command will build the project and deploy the infrastructure to your AWS account.
```

**IMPORTANT:**
During the deployment, you need to get nameservers from Route 53 and configure it at your domain provider. If you don't do that, the deployment will timeout and fail.

## Supavisor Localhost
If you want to run Supavisor at your localhost, you can do it this way:

Clone this repository:
```bash
cd supavisor-ecs/supavisor

docker-compose -f ./docker-compose.yml up
```

The command is going to run a postgres database + supavisor using docker in your localhost environment.

## After Deployment
You need to do a few steps in order to access the database after deployment, like Supavisor docs explain here (https://supabase.github.io/supavisor/development/setup/)

You need to create a tenant first, to access the database. This CDK is exposing the Supavisor API at the main port, so you can call like this
```
curl -i -X PUT \
  'https://<YOU_DOMAIN>/api/tenants/dev_tenant' \
  --header 'Accept: */*' \
  --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.wLKpjVW9IRyDIg2Wsrg9_vQ1oo3fk1Hsdi7RmP33giY' \
  --header 'Content-Type: application/json' \
  --data-raw '{
  "tenant": {
    "db_host": "<DB_CLUSTER_HOST>",
    "db_port": <DB_CLUSTER_PORT>,
    "db_database": "<DB_CLUSTER_DATABASE_NAME>",
    "ip_version": "auto",
    "enforce_ssl": false,
    "require_user": true,
    "users": [
      {
        "db_user": "<DB_CLUSTER_USER>",
        "db_password": "<DB_CLUSTER_PASSWORD>",
        "pool_size": 9,
        "mode_type": "transaction",
        "is_manager": true
      }
    ]
  }
}'
```

After that, you can access your Postgres using you favorite system or using the CLI, like this:
```
psql postgresql://postgres.dev_tenant:<DB_CLUSTER_PASSWORD>@pool.<YOU_DOMAIN>:6543/<DATABASE>
```

**IMPORTANT:**
Notice we are using a subdomain `pool.<DOMAIN>` for the connection pooler.

----------------------------------------------------------------------

## For running the tests

You can use `PgBench`. for it 

First you need to create the needed tables
```
pgbench -i -h pool.wpaws.cloud -p 6543 -U postgres.dev_tenant -d postgres
```

After this you can run the command as you prefer
```
pgbench -h pool.wpaws.cloud -p 6543 -U postgres.dev_tenant -d postgres -c <CLIENTS_NUMBER> -j <JOBS_NUMBER> -T <TIME>
```

You can turn the writer instance of the DB Cluster off during the tests. The downtime will be really fast, just the time of Aurora promoting one of the readers as the writer instance.

----------------------------------------------------------------------

## GitHub Actions Workflow
This repository includes a GitHub Actions workflow configured to deploy to different environments (development, staging, production) based on branch names (dev and main). The workflow automatically sets up the environment, configures AWS credentials, and deploys the infrastructure using AWS CDK.

## Environment Variables
**AWS_ACCESS_KEY_ID**: AWS Access Key ID for deployment.
**AWS_SECRET_ACCESS_KEY**: AWS Secret Access Key for deployment.

<img width="1434" alt="image" src="https://github.com/marcelinhov2/supavisor-ecs/assets/232648/1a83c90d-c6dc-4e67-babd-062499857d43">
