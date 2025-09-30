import { LambdaClient, ListFunctionsCommand, ListEventSourceMappingsCommand, GetFunctionCommand, ListAliasesCommand } from '@aws-sdk/client-lambda';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import AdmZip from 'adm-zip';
import https from 'node:https';
import { URL } from 'node:url';
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

const TEXT_FILE_EXTENSIONS = new Set([
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'json',
  'py',
  'java',
  'cs',
  'go',
  'rb',
  'php',
  'sh',
  'bash',
  'yml',
  'yaml',
  'txt',
  'md',
  'env'
]);

const MAX_ARCHIVE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB safety cap
const MAX_ENTRY_SIZE_BYTES = 10 * 1024 * 1024; // process text files up to 10 MB
const MAX_TOTAL_TEXT_BYTES = 40 * 1024 * 1024; // aggregate cap for text parsing

const SERVICE_HINT_PATTERNS = {
  SQS: {
    regexes: [
      { pattern: /https?:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/[0-9]{12}\/[A-Za-z0-9_.-]+/gi, resource: 'sqsQueueUrl' },
      { pattern: /QueueUrl\s*[:=]\s*['"](https?:\/\/sqs\.[^'"`]+)['"]/gi, resource: 'sqsQueueUrl' },
      { pattern: /\bSQSClient\b/g, resource: null },
      { pattern: /\bAWS\.SQS\b/g, resource: null },
      { pattern: /boto3\.client\(\s*['"]sqs['"]\s*\)/gi, resource: null },
      { pattern: /\bsqs\.sendMessage(Command)?\b/gi, resource: null },
      { pattern: /\bsqs\.send_message\b/gi, resource: null }
    ]
  },
  SNS: {
    regexes: [
      { pattern: /\barn:aws[a-zA-Z-]*:sns:[^\s'"`]+/gi, resource: 'arn' },
      { pattern: /\bSNSClient\b/g, resource: null },
      { pattern: /\bAWS\.SNS\b/g, resource: null },
      { pattern: /boto3\.client\(\s*['"]sns['"]\s*\)/gi, resource: null },
      { pattern: /\bsns\.publish\b/gi, resource: null }
    ]
  },
  S3: {
    regexes: [
      { pattern: /\bS3Client\b/g, resource: null },
      { pattern: /\bAWS\.S3\b/g, resource: null },
      { pattern: /boto3\.client\(\s*['"]s3['"]\s*\)/gi, resource: null },
      { pattern: /\bs3\.putObject\b/gi, resource: null },
      { pattern: /\bs3\.upload\b/gi, resource: null },
      { pattern: /\bPutObjectCommand\b/g, resource: null }
    ]
  },
  DynamoDB: {
    regexes: [
      { pattern: /\bDynamoDBClient\b/g, resource: null },
      { pattern: /\bDocumentClient\b/g, resource: null },
      { pattern: /boto3\.client\(\s*['"]dynamodb['"]\s*\)/gi, resource: null },
      { pattern: /boto3\.resource\(\s*['"]dynamodb['"]\s*\)/gi, resource: null },
      { pattern: /\bdynamodb\.put_item\b/gi, resource: null },
      { pattern: /\bdynamodb\.updateItem\b/gi, resource: null }
    ]
  },
  EventBridge: {
    regexes: [
      { pattern: /\bEventBridgeClient\b/g, resource: null },
      { pattern: /\bEventBridge\b/g, resource: null },
      { pattern: /\bPutEventsCommand\b/g, resource: null },
      { pattern: /boto3\.client\(\s*['"]events['"]\s*\)/gi, resource: null }
    ]
  },
  StepFunctions: {
    regexes: [
      { pattern: /\bSFNClient\b/g, resource: null },
      { pattern: /\bStepFunctionsClient\b/g, resource: null },
      { pattern: /boto3\.client\(\s*['"]stepfunctions['"]\s*\)/gi, resource: null },
      { pattern: /\bstartExecution\b/gi, resource: null }
    ]
  },
  Kinesis: {
    regexes: [
      { pattern: /\bKinesisClient\b/g, resource: null },
      { pattern: /boto3\.client\(\s*['"]kinesis['"]\s*\)/gi, resource: null },
      { pattern: /\bputRecords?\b/gi, resource: null }
    ]
  },
  SecretsManager: {
    regexes: [
      { pattern: /\bSecretsManagerClient\b/g, resource: null },
      { pattern: /boto3\.client\(\s*['"]secretsmanager['"]\s*\)/gi, resource: null }
    ]
  },
  SSM: {
    regexes: [
      { pattern: /\bSSMClient\b/g, resource: null },
      { pattern: /boto3\.client\(\s*['"]ssm['"]\s*\)/gi, resource: null },
      { pattern: /\bget_parameter\b/gi, resource: null }
    ]
  }
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

async function listAllAliases(lambdaClient, functionArn) {
  const aliases = [];
  let marker;
  do {
    const command = new ListAliasesCommand({ FunctionName: functionArn, Marker: marker });
    // eslint-disable-next-line no-await-in-loop
    const response = await lambdaClient.send(command);
    if (response.Aliases) {
      aliases.push(...response.Aliases);
    }
    marker = response.NextMarker;
  } while (marker);
  return aliases;
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

function addEventSourceRelations(builder, functionNodeId, mappings, qualifierArns) {
  mappings.forEach((mapping) => {
    if (!mapping.EventSourceArn) {
      return;
    }
    const node = describeArn(mapping.EventSourceArn);
    builder.addNode(node);
    let targetId = functionNodeId;
    const mappingFunctionArn = mapping.FunctionArn;
    if (mappingFunctionArn && mappingFunctionArn !== functionNodeId) {
      const normalizedMapping = normalizeFunctionArn(mappingFunctionArn);
      if (normalizedMapping === functionNodeId || (qualifierArns && qualifierArns.has(mappingFunctionArn))) {
        targetId = functionNodeId;
      }
    }
    builder.addEdge({ source: node.id, target: targetId, type: 'eventSource' });
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
    builder.addNode({ ...node, service: 'Layer' });
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

function normalizeFunctionArn(arn) {
  if (typeof arn !== 'string') {
    return null;
  }
  const trimmed = arn.trim();
  const parts = trimmed.split(':');
  if (parts.length > 7 && parts[5] === 'function') {
    return parts.slice(0, 7).join(':');
  }
  return trimmed;
}

async function downloadLambdaCodeArchive(lambdaClient, functionIdentifier) {
  const response = await lambdaClient.send(new GetFunctionCommand({ FunctionName: functionIdentifier }));
  const location = response?.Code?.Location;
  if (!location) {
    return null;
  }
  const archiveBuffer = await downloadBufferFromUrl(location);
  if (!archiveBuffer) {
    return null;
  }
  if (archiveBuffer.length > MAX_ARCHIVE_SIZE_BYTES) {
    throw new Error(`Code archive is too large (${Math.round(archiveBuffer.length / 1024)} KB)`);
  }
  return archiveBuffer;
}

async function downloadBufferFromUrl(url) {
  if (typeof fetch === 'function') {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Download failed with status ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      throw new Error(`Download failed: ${error?.message || error}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = https.get(parsed, (res) => {
      if (!res || res.statusCode === undefined) {
        reject(new Error('Invalid response when downloading code archive.'));
        return;
      }
      if (res.statusCode >= 400) {
        reject(new Error(`Download failed with status ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => {
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    });
    request.on('error', (error) => {
      reject(new Error(`Download failed: ${error?.message || error}`));
    });
    request.setTimeout(20000, () => {
      request.destroy(new Error('Download timed out.'));
    });
  });
}

function containsBinaryData(buffer, sampleSize = 1024) {
  const length = Math.min(buffer.length, sampleSize);
  for (let index = 0; index < length; index += 1) {
    const byte = buffer[index];
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

function extractTextEntriesFromArchive(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const results = [];
  let totalBytes = 0;

  entries.forEach((entry) => {
    if (entry.isDirectory) {
      return;
    }
    if (entry.entryName.startsWith('__MACOSX/')) {
      return;
    }
    const ext = entry.entryName.split('.').pop()?.toLowerCase() ?? '';
    if (!TEXT_FILE_EXTENSIONS.has(ext)) {
      return;
    }

    const data = entry.getData();
    if (!data || data.length === 0) {
      return;
    }

    if (data.length > MAX_ENTRY_SIZE_BYTES || containsBinaryData(data)) {
      return;
    }

    totalBytes += data.length;
    if (totalBytes > MAX_TOTAL_TEXT_BYTES) {
      return;
    }

    try {
      const content = data.toString('utf8');
      results.push({ path: entry.entryName, content });
    } catch (error) {
      // Ignore files that cannot be decoded as UTF-8
    }
  });

  return results;
}

function findLambdaInvocationTargets(entries) {
  const targets = new Map();

  entries.forEach(({ content }) => {
    if (typeof content !== 'string') {
      return;
    }

    const arnRegex = /arn:aws[a-zA-Z-]*:lambda:[^\s'"`]+/g;
    let arnMatch;
    while ((arnMatch = arnRegex.exec(content)) !== null) {
      const arn = arnMatch[0];
      const key = `arn|${arn}`;
      if (!targets.has(key)) {
        targets.set(key, { type: 'arn', value: arn });
      }
    }

    const functionNameRegex = /FunctionName\s*[:=]\s*(["'])(.*?)\1|FunctionName\s*[:=]\s*`([\s\S]*?)`/gi;
    let fnMatch;
    while ((fnMatch = functionNameRegex.exec(content)) !== null) {
      const name = fnMatch[0].slice('FunctionName: `'.length, -1);
      const key = `name|${name}`;
      if (!targets.has(key)) {
        targets.set(key, { type: 'name', value: name });
      }
    }

    const invokeRegex = /\.invoke\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let invokeMatch;
    while ((invokeMatch = invokeRegex.exec(content)) !== null) {
      const name = invokeMatch[1];
      const key = `name|${name}`;
      if (!targets.has(key)) {
        targets.set(key, { type: 'name', value: name });
      }
    }
  });

  return Array.from(targets.values());
}

function resolveLambdaTarget(target, lambdaByArn, lambdaByName) {
  if (!target || typeof target.value !== 'string') {
    return null;
  }

  if (target.type === 'arn') {
    const normalized = normalizeFunctionArn(target.value);
    const known = lambdaByArn.get(target.value) || lambdaByArn.get(normalized ?? target.value);
    if (known) {
      const nodeId = known.FunctionArn || known.FunctionName;
      return { nodeId, label: known.FunctionName || nodeId };
    }
    const label = normalized ? normalized.split(':').pop() : target.value;
    return {
      nodeId: normalized ?? target.value,
      label: label || target.value
    };
  }

  const rawName = target.value.trim();
  if (!rawName) {
    return null;
  }

  const baseName = rawName.split(':')[0];
  const known = lambdaByName.get(rawName) || lambdaByName.get(baseName);
  if (known) {
    const nodeId = known.FunctionArn || known.FunctionName;
    return { nodeId, label: known.FunctionName || nodeId };
  }

  return {
    nodeId: `lambda://${baseName}`,
    label: baseName
  };
}

function sqsUrlToArn(url) {
  const match = /^https?:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\/([0-9]{12})\/([A-Za-z0-9_.-]+)/i.exec(url);
  if (!match) {
    return null;
  }
  const [, region, accountId, queueName] = match;
  return `arn:aws:sqs:${region}:${accountId}:${queueName}`;
}

function findServiceUsageHints(entries) {
  const hints = new Map();

  entries.forEach(({ content }) => {
    if (typeof content !== 'string' || content.length === 0) {
      return;
    }

    Object.entries(SERVICE_HINT_PATTERNS).forEach(([service, config]) => {
      config.regexes.forEach(({ pattern, resource }) => {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const matchedValue = match[1] ?? match[0];
          let resourceInfo = null;
          if (resource === 'arn') {
            resourceInfo = { type: 'arn', value: matchedValue };
          } else if (resource === 'sqsQueueUrl') {
            resourceInfo = { type: 'sqsQueueUrl', value: matchedValue };
          }

          const keyParts = [service];
          if (resourceInfo) {
            keyParts.push(resourceInfo.type, resourceInfo.value);
          }
          const key = keyParts.join('|');
          if (!hints.has(key)) {
            hints.set(key, { service, resource: resourceInfo });
          }
        }
      });
    });
  });

  return Array.from(hints.values());
}

function resolveServiceUsageHint(hint) {
  if (!hint || !hint.service) {
    return null;
  }

  if (hint.resource?.type === 'arn') {
    const node = describeArn(hint.resource.value);
    return {
      node,
      type: 'resource'
    };
  }

  if (hint.resource?.type === 'sqsQueueUrl') {
    const arn = sqsUrlToArn(hint.resource.value);
    if (arn) {
      const node = describeArn(arn);
      return {
        node,
        type: 'resource'
      };
    }
    const queueUrl = hint.resource.value;
    const queueName = queueUrl.split('/').pop() || queueUrl;
    const nodeId = `sqs-queue://${encodeURIComponent(queueUrl)}`;
    return {
      node: {
        id: nodeId,
        label: queueName,
        service: 'SQS'
      },
      type: 'resource'
    };
  }

  return null;
}

async function discoverLambdaInvocationRelations(lambdaClient, builder, lambdaFunctions, warnings) {
  if (!Array.isArray(lambdaFunctions) || lambdaFunctions.length === 0) {
    return { attempted: 0, scanned: 0, failures: 0, addedEdges: 0 };
  }

  const lambdaByArn = new Map();
  const lambdaByName = new Map();

  lambdaFunctions.forEach((fn) => {
    if (!fn) {
      return;
    }
    if (fn.FunctionArn) {
      lambdaByArn.set(fn.FunctionArn, fn);
      const normalized = normalizeFunctionArn(fn.FunctionArn);
      if (normalized) {
        lambdaByArn.set(normalized, fn);
      }
    }
    if (fn.FunctionName) {
      lambdaByName.set(fn.FunctionName, fn);
    }
  });

  let scanned = 0;
  let failures = 0;
  let addedInvocationEdges = 0;
  let addedServiceEdges = 0;
  const attempted = lambdaFunctions.length;

  for (const fn of lambdaFunctions) {
    if (!fn) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const functionIdentifier = fn.FunctionArn || fn.FunctionName;
    if (!functionIdentifier) {
      // eslint-disable-next-line no-continue
      continue;
    }

    let archiveBuffer;
    try {
      // eslint-disable-next-line no-await-in-loop
      archiveBuffer = await downloadLambdaCodeArchive(lambdaClient, functionIdentifier);
      if (!archiveBuffer) {
        // eslint-disable-next-line no-continue
        continue;
      }
    } catch (error) {
      failures += 1;
      warnings.push(`Failed to download code for ${fn.FunctionName || functionIdentifier}: ${error?.message || error}`);
      // eslint-disable-next-line no-continue
      continue;
    }

    scanned += 1;
    let entries;
    try {
      entries = extractTextEntriesFromArchive(archiveBuffer);
    } catch (error) {
      failures += 1;
      warnings.push(`Failed to inspect archive for ${fn.FunctionName || functionIdentifier}: ${error?.message || error}`);
      // eslint-disable-next-line no-continue
      continue;
    }

    if (!entries || entries.length === 0) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const targets = findLambdaInvocationTargets(entries);
    if (!targets.length) {
      // eslint-disable-next-line no-continue
      continue;
    }

    targets.forEach((target) => {
      const resolved = resolveLambdaTarget(target, lambdaByArn, lambdaByName);
      if (!resolved) {
        return;
      }

      const sourceId = fn.FunctionArn || fn.FunctionName;
      if (resolved.nodeId === sourceId) {
        return;
      }

      builder.addNode({ id: resolved.nodeId, label: resolved.label, service: 'Lambda' });
      const before = builder.edges.length;
      builder.addEdge({ source: sourceId, target: resolved.nodeId, type: 'invokes' });
      if (builder.edges.length > before) {
        addedInvocationEdges += 1;
      }
    });

    const serviceHints = findServiceUsageHints(entries);
    serviceHints.forEach((hint) => {
      const resolved = resolveServiceUsageHint(hint);
      if (!resolved || !resolved.node) {
        return;
      }

      const targetNode = builder.addNode({
        id: resolved.node.id,
        label: resolved.node.label,
        service: resolved.node.service
      });

      const sourceId = fn.FunctionArn || fn.FunctionName;
      const before = builder.edges.length;
      builder.addEdge({ source: sourceId, target: targetNode.id, type: 'usesService' });
      if (builder.edges.length > before) {
        addedServiceEdges += 1;
      }
    });
  }

  return {
    attempted,
    scanned,
    failures,
    invocationEdges: addedInvocationEdges,
    serviceEdges: addedServiceEdges
  };
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

    const mappingAccumulator = new Map();

    function recordMappings(list = []) {
      list.forEach((mapping) => {
        if (!mapping) {
          return;
        }
        const key = mapping.UUID || `${mapping.EventSourceArn || 'unknown'}|${mapping.FunctionArn || functionNodeId}`;
        if (!mappingAccumulator.has(key)) {
          mappingAccumulator.set(key, mapping);
        }
      });
    }

    const qualifierArns = new Set([functionNodeId]);
    if (fn.Version && fn.Version !== '$LATEST') {
      const versionArn = `${functionNodeId}:${fn.Version}`;
      qualifierArns.add(versionArn);
      try {
        // eslint-disable-next-line no-await-in-loop
        const publishedMappings = await listAllEventSourceMappings(lambdaClient, versionArn);
        recordMappings(publishedMappings);
      } catch (publishedError) {
        warnings.push(`Failed to list event source mappings for version ${versionArn}: ${publishedError?.message || publishedError}`);
      }
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const aliases = await listAllAliases(lambdaClient, functionNodeId);
      for (const alias of aliases) {
        const aliasArn = alias.AliasArn || `${functionNodeId}:${alias.Name}`;
        qualifierArns.add(aliasArn);
        if (alias.Name) {
          qualifierArns.add(`${fn.FunctionName}:${alias.Name}`);
        }
        if (alias.FunctionVersion) {
          qualifierArns.add(`${functionNodeId}:${alias.FunctionVersion}`);
          try {
            // eslint-disable-next-line no-await-in-loop
            const versionMappings = await listAllEventSourceMappings(lambdaClient, `${functionNodeId}:${alias.FunctionVersion}`);
            recordMappings(versionMappings);
          } catch (versionError) {
            warnings.push(`Failed to list event source mappings for version ${functionNodeId}:${alias.FunctionVersion}: ${versionError?.message || versionError}`);
          }
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          const aliasMappings = await listAllEventSourceMappings(lambdaClient, aliasArn);
          recordMappings(aliasMappings);
        } catch (aliasError) {
          warnings.push(`Failed to list event source mappings for alias ${aliasArn}: ${aliasError?.message || aliasError}`);
        }
      };
    } catch (error) {
      warnings.push(`Failed to list aliases for ${fn.FunctionName}: ${error?.message || error}`);
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const mappings = await listAllEventSourceMappings(lambdaClient, functionNodeId);
      recordMappings(mappings);
    } catch (error) {
      warnings.push(`Failed to list event source mappings for ${fn.FunctionName}: ${error?.message || error}`);
    }

    addEventSourceRelations(builder, functionNodeId, Array.from(mappingAccumulator.values()), qualifierArns);

    addDeadLetterRelation(builder, functionNodeId, fn.DeadLetterConfig);
    addRoleRelation(builder, functionNodeId, fn.Role);
    addLayerRelations(builder, functionNodeId, fn.Layers);
    addVpcRelations(builder, functionNodeId, fn.VpcConfig);
    addEnvironmentRelations(builder, functionNodeId, fn.Environment);
    addFilesystemRelations(builder, functionNodeId, fn.FileSystemConfigs);
    addKmsRelation(builder, functionNodeId, fn.KMSKeyArn);
    addDestinationRelations(builder, functionNodeId, fn.FunctionResponseTypes);
  }

  const invocationStats = await discoverLambdaInvocationRelations(lambdaClient, builder, lambdaFunctions, warnings);
  if (invocationStats) {
    const attemptCount = invocationStats.attempted ?? lambdaFunctions.length;
    const status = attemptCount > 0 && invocationStats.failures === attemptCount ? 'failure' : 'success';
    const messageParts = [`Analyzed ${invocationStats.scanned}/${attemptCount} Lambda code package(s)`];
    messageParts.push(`found ${invocationStats.invocationEdges ?? 0} Lambda invocation link(s)`);
    if (invocationStats.serviceEdges) {
      messageParts.push(`found ${invocationStats.serviceEdges} service usage link(s)`);
    }
    if (invocationStats.failures) {
      messageParts.push(`${invocationStats.failures} package(s) failed to analyze`);
    }
    validationSteps.push({
      action: 'codeAnalysis',
      status,
      message: `${messageParts.join('; ')}.`
    });
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
