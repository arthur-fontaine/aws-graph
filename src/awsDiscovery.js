import { LambdaClient, ListFunctionsCommand, ListEventSourceMappingsCommand } from '@aws-sdk/client-lambda';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { serviceColors } from './serviceColors.js';

const serviceNameMap = {
  lambda: 'Lambda',
  s3: 'S3',
  dynamodb: 'DynamoDB',
  sqs: 'SQS',
  sns: 'SNS',
  events: 'EventBridge',
  eventbridge: 'EventBridge',
  states: 'StepFunctions',
  logs: 'CloudWatch',
  cloudwatch: 'CloudWatch',
  cloudwatchevents: 'CloudWatchEvents',
  cloudtrail: 'CloudTrail',
  ec2: 'EC2',
  elasticloadbalancing: 'ELB',
  elasticfilesystem: 'EFS',
  kms: 'KMS',
  iam: 'IAM',
  rds: 'RDS',
  secretsmanager: 'SecretsManager',
  ssm: 'SSM',
  ssmmessages: 'SSM',
  servicediscovery: 'CloudMap',
  kinesis: 'Kinesis'
};

class GraphBuilder {
  constructor() {
    this.nodes = [];
    this.edges = [];
    this.nodeIndex = new Map();
    this.edgeIndex = new Set();
  }

  addNode(node) {
    if (!node?.id) {
      throw new Error('Node must include an id');
    }

    if (this.nodeIndex.has(node.id)) {
      return this.nodeIndex.get(node.id);
    }

    const normalizedNode = {
      id: node.id,
      label: node.label ?? node.id,
      service: node.service ?? 'Unknown'
    };

    this.nodes.push(normalizedNode);
    this.nodeIndex.set(node.id, normalizedNode);
    return normalizedNode;
  }

  addEdge(edge) {
    if (!edge?.source || !edge?.target) {
      return;
    }

    const key = `${edge.source}|${edge.target}|${edge.type ?? ''}`;
    if (this.edgeIndex.has(key)) {
      return;
    }

    const normalizedEdge = {
      source: edge.source,
      target: edge.target,
      ...(edge.type ? { type: edge.type } : {})
    };

    this.edges.push(normalizedEdge);
    this.edgeIndex.add(key);
  }

  toGraph() {
    return {
      nodes: this.nodes,
      edges: this.edges
    };
  }
}

function resolveRegion() {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  return region;
}

function normalizeService(rawService = '') {
  const key = rawService.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (serviceNameMap[key]) {
    return serviceNameMap[key];
  }
  if (!rawService) {
    return 'Unknown';
  }
  const capitalized = rawService.charAt(0).toUpperCase() + rawService.slice(1);
  return capitalized;
}

function parseArn(arn) {
  if (typeof arn !== 'string' || !arn.startsWith('arn:')) {
    return null;
  }

  const parts = arn.split(':');
  if (parts.length < 6) {
    return null;
  }

  const [arnPrefix, partition, service, region, accountId, ...resourceParts] = parts;
  const resource = resourceParts.join(':');
  let resourceType = '';
  let resourceId = resource;

  if (resource.includes('/')) {
    const resourceSegments = resource.split('/');
    resourceType = resourceSegments[0];
    resourceId = resourceSegments[resourceSegments.length - 1];
  } else if (resource.includes(':')) {
    const resourceSegments = resource.split(':');
    resourceType = resourceSegments[0];
    resourceId = resourceSegments[resourceSegments.length - 1];
  }

  if (!resourceId) {
    resourceId = resource;
  }

  return {
    arn,
    partition,
    service,
    region,
    accountId,
    resource,
    resourceType,
    resourceId
  };
}

function describeArn(arn) {
  const parsed = parseArn(arn);
  if (!parsed) {
    return {
      id: arn,
      label: arn,
      service: 'Unknown'
    };
  }

  const niceService = normalizeService(parsed.service);
  let label = parsed.resourceId || parsed.resource;

  if (!label || label === parsed.resource) {
    label = parsed.resource.split(/[/:]/).filter(Boolean).pop() || parsed.resource;
  }

  if (niceService === 'S3' && parsed.resource) {
    label = parsed.resource.replace(/^\/+/, '');
  }

  return {
    id: arn,
    label,
    service: niceService
  };
}

function createVpcNode(id, type) {
  const label = `${type}:${id}`;
  return {
    id: `${type}:${id}`,
    label,
    service: 'VPC'
  };
}

async function validateCredentials(region) {
  const provider = fromNodeProviderChain({
    timeout: 5000
  });
  try {
    const credentials = await provider();
    const sts = new STSClient({ region: region || 'us-east-1', credentials });
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    return { ok: true, credentials, identity };
  } catch (error) {
    return { ok: false, error };
  }
}

async function listAllLambdaFunctions(lambdaClient) {
  const functions = [];
  let marker;
  do {
    const command = new ListFunctionsCommand({ Marker: marker });
    // eslint-disable-next-line no-await-in-loop
    const response = await lambdaClient.send(command);
    if (response.Functions) {
      functions.push(...response.Functions);
    }
    marker = response.NextMarker;
  } while (marker);
  return functions;
}

async function listAllEventSourceMappings(lambdaClient, functionArn) {
  const results = [];
  let marker;
  do {
    const command = new ListEventSourceMappingsCommand({ FunctionName: functionArn, Marker: marker });
    // eslint-disable-next-line no-await-in-loop
    const response = await lambdaClient.send(command);
    if (response.EventSourceMappings) {
      results.push(...response.EventSourceMappings);
    }
    marker = response.NextMarker;
  } while (marker);
  return results;
}

function extractArnsFromEnv(env = {}) {
  const arns = new Set();
  const arnRegex = /arn:[A-Za-z0-9_\-:/.]+/g;
  const s3Regex = /s3:\/\/([A-Za-z0-9_.\-]+)/g;

  Object.values(env).forEach((value) => {
    if (typeof value !== 'string') {
      return;
    }

    const arnMatches = value.match(arnRegex);
    if (arnMatches) {
      arnMatches.forEach((match) => arns.add(match));
    }

    let match;
    while ((match = s3Regex.exec(value)) !== null) {
      const bucketName = match[1];
      arns.add(`arn:aws:s3:::${bucketName}`);
    }
  });

  return Array.from(arns);
}

function addEventSourceRelations(builder, functionNodeId, mappings) {
  mappings.forEach((mapping) => {
    if (!mapping.EventSourceArn) {
      return;
    }
    const node = describeArn(mapping.EventSourceArn);
    builder.addNode(node);
    builder.addEdge({ source: functionNodeId, target: node.id, type: 'eventSource' });
  });
}

function addDeadLetterRelation(builder, functionNodeId, deadLetterConfig) {
  if (!deadLetterConfig?.TargetArn) {
    return;
  }
  const node = describeArn(deadLetterConfig.TargetArn);
  builder.addNode(node);
  builder.addEdge({ source: functionNodeId, target: node.id, type: 'dlq' });
}

function addRoleRelation(builder, functionNodeId, roleArn) {
  if (!roleArn) {
    return;
  }
  const roleNode = describeArn(roleArn);
  roleNode.service = 'IAM';
  builder.addNode(roleNode);
  builder.addEdge({ source: functionNodeId, target: roleNode.id, type: 'usesRole' });
}

function addLayerRelations(builder, functionNodeId, layers = []) {
  layers.forEach((layer) => {
    if (!layer.Arn) {
      return;
    }
    const node = describeArn(layer.Arn);
    builder.addNode({ ...node, service: 'Lambda' });
    builder.addEdge({ source: functionNodeId, target: node.id, type: 'layer' });
  });
}

function addVpcRelations(builder, functionNodeId, vpcConfig) {
  if (!vpcConfig) {
    return;
  }

  (vpcConfig.SubnetIds || []).forEach((subnetId) => {
    if (!subnetId) {
      return;
    }
    const node = createVpcNode(subnetId, 'subnet');
    builder.addNode(node);
    builder.addEdge({ source: functionNodeId, target: node.id, type: 'subnet' });
  });

  (vpcConfig.SecurityGroupIds || []).forEach((sgId) => {
    if (!sgId) {
      return;
    }
    const node = createVpcNode(sgId, 'sg');
    builder.addNode(node);
    builder.addEdge({ source: functionNodeId, target: node.id, type: 'securityGroup' });
  });
}

function addEnvironmentRelations(builder, functionNodeId, environment) {
  if (!environment?.Variables) {
    return;
  }

  const arns = extractArnsFromEnv(environment.Variables);
  arns.forEach((arn) => {
    const node = describeArn(arn);
    builder.addNode(node);
    builder.addEdge({ source: functionNodeId, target: node.id, type: 'configRef' });
  });
}

function addFilesystemRelations(builder, functionNodeId, fileSystemConfigs = []) {
  fileSystemConfigs.forEach((fsConfig) => {
    if (!fsConfig.Arn) {
      return;
    }
    const node = describeArn(fsConfig.Arn);
    builder.addNode({ ...node, service: 'EFS' });
    builder.addEdge({ source: functionNodeId, target: node.id, type: 'efs' });
  });
}

function addKmsRelation(builder, functionNodeId, kmsArn) {
  if (!kmsArn) {
    return;
  }
  const node = describeArn(kmsArn);
  builder.addNode({ ...node, service: 'KMS' });
  builder.addEdge({ source: functionNodeId, target: node.id, type: 'encryption' });
}

function addDestinationRelations(builder, functionNodeId, functionResponseTypes = []) {
  functionResponseTypes.forEach((config) => {
    if (!config.DestinationConfig) {
      return;
    }
    const destinations = Object.values(config.DestinationConfig).filter(Boolean);
    destinations.forEach((destinationArn) => {
      const node = describeArn(destinationArn);
      builder.addNode(node);
      builder.addEdge({ source: functionNodeId, target: node.id, type: 'destination' });
    });
  });
}

export async function buildAwsGraph() {
  const validationSteps = [];
  const warnings = [];

  const region = resolveRegion();
  const credentialCheck = await validateCredentials(region);

  if (!credentialCheck.ok) {
    const message = credentialCheck.error?.message || 'Unable to resolve AWS credentials.';
    validationSteps.push({
      action: 'authentication',
      status: 'failure',
      message: message.slice(0, 200)
    });

    return {
      graph: { nodes: [], edges: [] },
      validationSteps,
      warnings,
      error: 'AWS credentials are missing or invalid. Please configure your ~/.aws credentials.'
    };
  }

  const identity = credentialCheck.identity;
  validationSteps.push({
    action: 'authentication',
    status: 'success',
    message: `Authenticated as ${identity?.Arn ?? 'unknown principal'} in ${region}.`
  });

  const lambdaClient = new LambdaClient({
    region,
    credentials: credentialCheck.credentials
  });

  const builder = new GraphBuilder();
  let lambdaFunctions;
  try {
    lambdaFunctions = await listAllLambdaFunctions(lambdaClient);
  } catch (error) {
    const reason = error?.message || 'Unknown error while listing Lambda functions.';
    validationSteps.push({
      action: 'resourceDiscovery',
      status: 'failure',
      message: `ListFunctions failed: ${reason}`.slice(0, 200)
    });

    return {
      graph: { nodes: [], edges: [] },
      validationSteps,
      warnings,
      error: `Failed to retrieve Lambda functions: ${reason}`
    };
  }

  if (lambdaFunctions.length === 0) {
    validationSteps.push({
      action: 'resourceDiscovery',
      status: 'failure',
      message: 'No Lambda functions were found.'
    });

    return {
      graph: { nodes: [], edges: [] },
      validationSteps,
      warnings,
      error: 'No Lambda functions were discovered. Please deploy at least one Lambda function.'
    };
  }

  for (const fn of lambdaFunctions) {
    const functionNodeId = fn.FunctionArn || fn.FunctionName;
    builder.addNode({ id: functionNodeId, label: fn.FunctionName, service: 'Lambda' });

    try {
      // eslint-disable-next-line no-await-in-loop
      const mappings = await listAllEventSourceMappings(lambdaClient, functionNodeId);
      addEventSourceRelations(builder, functionNodeId, mappings);
    } catch (error) {
      warnings.push(`Failed to list event source mappings for ${fn.FunctionName}: ${error.message}`);
    }

    addDeadLetterRelation(builder, functionNodeId, fn.DeadLetterConfig);
    addRoleRelation(builder, functionNodeId, fn.Role);
    addLayerRelations(builder, functionNodeId, fn.Layers);
    addVpcRelations(builder, functionNodeId, fn.VpcConfig);
    addEnvironmentRelations(builder, functionNodeId, fn.Environment);
    addFilesystemRelations(builder, functionNodeId, fn.FileSystemConfigs);
    addKmsRelation(builder, functionNodeId, fn.KMSKeyArn);
    addDestinationRelations(builder, functionNodeId, fn.FunctionResponseTypes);
  }

  const graph = builder.toGraph();
  const relatedCount = Math.max(graph.nodes.length - lambdaFunctions.length, 0);

  validationSteps.push({
    action: 'resourceDiscovery',
    status: 'success',
    message: `Discovered ${lambdaFunctions.length} Lambda function(s) and ${relatedCount} related resource(s).`
  });

  return {
    graph,
    validationSteps,
    warnings,
    region
  };
}

export { serviceColors, resolveRegion };
