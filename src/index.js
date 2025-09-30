import http from 'node:http';
import { buildAwsGraph, serviceColors, resolveRegion } from './awsDiscovery.js';

const PORT = process.env.PORT || 3000;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeLabel(value) {
  return String(value ?? '').replace(/"/g, '\\"');
}

function serviceToClassName(service) {
  return String(service || 'Unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'unknown';
}

function normalizeColor(color) {
  if (!color) {
    return '#999999';
  }
  if (color.startsWith('#') && (color.length === 7 || color.length === 4)) {
    return color;
  }
  return `#${color}`;
}

function pickTextColor(hex) {
  const cleanHex = normalizeColor(hex).replace('#', '');
  const expanded = cleanHex.length === 3
    ? cleanHex.split('').map((char) => char + char).join('')
    : cleanHex;

  const r = parseInt(expanded.slice(0, 2), 16) / 255;
  const g = parseInt(expanded.slice(2, 4), 16) / 255;
  const b = parseInt(expanded.slice(4, 6), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.65 ? '#000000' : '#ffffff';
}

function buildMermaidDiagram(graph) {
  if (!graph?.nodes?.length) {
    return {
      diagram: 'graph TD\n  empty["No data available"]',
      services: new Set()
    };
  }

  const lines = ['graph TD'];
  const serviceSet = new Set();
  const nodeIdMap = new Map();

  graph.nodes.forEach((node, index) => {
    const mermaidId = `n${index}`;
    nodeIdMap.set(node.id, mermaidId);
    const service = node.service || 'Unknown';
    serviceSet.add(service);
    const className = serviceToClassName(service);
    const label = escapeLabel(node.label || node.id || `Node ${index}`);
    lines.push(`  ${mermaidId}["${label}"]:::${className}`);
  });

  graph.edges.forEach((edge) => {
    const sourceId = nodeIdMap.get(edge.source);
    const targetId = nodeIdMap.get(edge.target);
    if (!sourceId || !targetId) {
      return;
    }
    const label = edge.type ? `|${escapeLabel(edge.type)}|` : '';
    lines.push(`  ${sourceId} -->${label ? `${label} ` : ' '}${targetId}`);
  });

  const classDefs = Array.from(serviceSet).map((service) => {
    const className = serviceToClassName(service);
    const fill = serviceColors[service] || serviceColors.Unknown || '#999999';
    const textColor = pickTextColor(fill);
    return `classDef ${className} fill:${fill},stroke:#333,color:${textColor};`;
  });

  return {
    diagram: [...lines, ...classDefs].join('\n'),
    services: serviceSet
  };
}

function renderValidationList(validationSteps = []) {
  if (!validationSteps.length) {
    return '<p>No validation steps recorded.</p>';
  }

  const items = validationSteps.map((step) => {
    const statusClass = step.status === 'success' ? 'ok' : step.status === 'failure' ? 'fail' : 'unknown';
    return `<li class="${statusClass}"><strong>${escapeHtml(step.action)}:</strong> ${escapeHtml(step.message)}</li>`;
  });

  return `<ul class="validation">${items.join('')}</ul>`;
}

function renderWarnings(warnings = []) {
  if (!warnings.length) {
    return '';
  }

  const items = warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
  return `<div id="warnings"><h2>Warnings</h2><ul>${items}</ul></div>`;
}

function buildHtmlPage({
  mermaidDiagram,
  graph,
  validationSteps,
  error,
  warnings
}) {
  const graphJson = escapeHtml(JSON.stringify(graph, null, 2));
  const validationHtml = renderValidationList(validationSteps);
  const warningsHtml = renderWarnings(warnings);
  const errorHtml = error ? `<div id="error">${escapeHtml(error)}</div>` : '';
  const regionInfo = escapeHtml(resolveRegion());

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>AWS Service Graph</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
    <script>
      mermaid.initialize({ startOnLoad: true, securityLevel: 'loose' });
    </script>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 2rem; background: #f5f5f5; color: #222; }
      h1 { margin-top: 0; }
      #error { background: #ffefef; border: 1px solid #e78; padding: 1rem; margin-bottom: 1rem; font-weight: bold; color: #a00; }
      #warnings { background: #fff8e6; border: 1px solid #f4c542; padding: 1rem; margin-bottom: 1rem; }
      #warnings ul { margin: 0; padding-left: 1.5rem; }
      .validation { list-style: none; padding: 0; margin: 0 0 1rem 0; display: grid; gap: 0.25rem; }
      .validation li { padding: 0.5rem 0.75rem; border-radius: 4px; background: #fff; border-left: 4px solid transparent; }
      .validation li.ok { border-color: #2e8540; }
      .validation li.fail { border-color: #c00; }
      .validation li.unknown { border-color: #999; }
      .mermaid { background: #fff; border-radius: 8px; padding: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
      pre { background: #111; color: #f5f5f5; padding: 1rem; border-radius: 8px; overflow-x: auto; }
      footer { margin-top: 2rem; font-size: 0.875rem; color: #555; }
    </style>
  </head>
  <body>
    <h1>AWS Service Graph</h1>
    <p>Region: ${regionInfo}</p>
    ${errorHtml}
    ${warningsHtml}
    <section id="validation">
      <h2>Validation</h2>
      ${validationHtml}
    </section>
    <section id="graph">
      <h2>Graph</h2>
      <div class="mermaid">
${mermaidDiagram}
      </div>
    </section>
    <section id="json">
      <h2>Graph JSON</h2>
      <pre>${graphJson}</pre>
    </section>
    <footer>Service colors are hardcoded in the application.</footer>
  </body>
</html>`;
}

async function handleRequest(req, res) {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  let result;
  try {
    result = await buildAwsGraph();
  } catch (error) {
    const message = `Unexpected error while building graph: ${error?.message || 'Unknown error'}`;
    const body = buildHtmlPage({
      mermaidDiagram: 'graph TD\n  failed["Unable to render graph"]',
      graph: { nodes: [], edges: [] },
      validationSteps: [{ action: 'runtime', status: 'failure', message }],
      error: message,
      warnings: []
    });
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(body);
    return;
  }

  const validationSteps = Array.isArray(result.validationSteps)
    ? [...result.validationSteps]
    : [];

  if (result.error) {
    validationSteps.push({
      action: 'graphRendering',
      status: 'failure',
      message: 'Graph rendering skipped because discovery failed.'
    });
  } else {
    validationSteps.push({
      action: 'graphRendering',
      status: 'success',
      message: `Rendered ${result.graph.nodes.length} node(s) and ${result.graph.edges.length} edge(s).`
    });
  }

  if (req.url === '/graph.json') {
    res.writeHead(result.error ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      graph: result.graph,
      validationSteps,
      warnings: result.warnings,
      error: result.error ?? null
    }, null, 2));
    return;
  }

  const mermaid = buildMermaidDiagram(result.graph);
  const html = buildHtmlPage({
    mermaidDiagram: mermaid.diagram,
    graph: result.graph,
    validationSteps,
    error: result.error,
    warnings: result.warnings
  });

  res.writeHead(result.error ? 503 : 200, { 'Content-Type': 'text/html' });
  res.end(html);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Unhandled error: ${error?.message || error}`);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`AWS graph server running at http://localhost:${PORT}`);
});
