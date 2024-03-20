const { Client } = require('pg');

module.exports.handler = async function (event) {
    console.log('request:', JSON.stringify(event, undefined, 2));
    switch (event.RequestType) {
        case 'Create':
            console.log('create event');
        default:
            console.log('did not match event type');
    }

    const connStr = process.env.DATABASE_URL;

    await execute(connStr, 'create role anon          nologin noinherit;');
    await execute(connStr, 'create role authenticated nologin noinherit;');
    await execute(connStr, 'create role service_role  nologin noinherit bypassrls;');

    await execute(connStr, 'grant usage on schema public to anon, authenticated, service_role;');

    await execute(connStr, 'alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;');
    await execute(connStr, 'alter default privileges in schema public grant all on functions to anon, authenticated, service_role;');
    await execute(connStr, 'alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;');

    await execute(connStr, 'create schema if not exists _supavisor;');

    //TODO fail when an error happens so that the system rolls back
    return {
        Status: 'SUCCESS',
        Reason: '',
        LogicalResourceId: event.LogicalResourceId,
        //PhysicalResourceId: directoryId + '+user-' + username,
        RequestId: event.RequestId,
        StackId: event.StackId,
    };
};
async function execute(connStr, command) {
    try {
        await executeQuery(connStr, command);
    } catch (e) {
        console.log('error executing query', command, e);
    }
}
async function executeQuery(connStr, command) {
    const dbconn = {
        connectionString: connStr,
        query_timeout: 5000,
        connectionTimeoutMillis: 5000,
    };
    const client = new Client(dbconn);
    await client.connect();
    try {
        const q = await client.query(command);
        console.log(q);
    } catch (e) {
        console.log('error executing ', command, e);
    } finally {
        await client.end();
    }
}
