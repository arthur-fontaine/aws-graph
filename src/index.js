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

function serializeForScript(value) {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
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
  graph,
  validationSteps,
  error,
  warnings,
  serviceColorsMap
}) {
  const graphJsonEscaped = escapeHtml(JSON.stringify(graph, null, 2));
  const validationHtml = renderValidationList(validationSteps);
  const warningsHtml = renderWarnings(warnings);
  const errorHtml = error ? `<div id="error">${escapeHtml(error)}</div>` : '';
  const regionInfo = escapeHtml(resolveRegion());
  const scriptGraph = serializeForScript(graph);
  const scriptColors = serializeForScript(serviceColorsMap);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>AWS Service Graph</title>
    <link rel="stylesheet" href="https://unpkg.com/reactflow@11.10.0/dist/style.css">
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      html, body { height: 100%; margin: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #222; display: flex; flex-direction: column; min-height: 100vh; }
      h1 { margin: 0 0 0.5rem 0; }
      main { flex: 1; display: flex; flex-direction: column; gap: 1rem; padding: 1.75rem; }
      #error { background: #ffefef; border: 1px solid #e78; padding: 1rem; font-weight: bold; color: #a00; }
      #warnings { background: #fff8e6; border: 1px solid #f4c542; padding: 1rem; }
      #warnings ul { margin: 0; padding-left: 1.5rem; }
      .validation { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.25rem; }
      .validation li { padding: 0.5rem 0.75rem; border-radius: 4px; background: #fff; border-left: 4px solid transparent; }
      .validation li.ok { border-color: #2e8540; }
      .validation li.fail { border-color: #c00; }
      .validation li.unknown { border-color: #999; }
      section { background: rgba(255,255,255,0.92); border-radius: 8px; padding: 1rem 1.25rem; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
      section header { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.5rem; }
      section header h2 { margin: 0; font-size: 1.125rem; }
      section#graph { flex: 1; display: flex; flex-direction: column; min-height: 0; }
      #graph-root { flex: 1; min-height: 480px; border: 1px solid #d1d1d1; border-radius: 8px; overflow: hidden; background: #fff; }
      section#json pre { background: #111; color: #f5f5f5; padding: 1rem; border-radius: 8px; margin: 0; overflow-x: auto; max-height: 240px; font-size: 0.85rem; }
      footer { padding: 1rem 1.75rem; font-size: 0.85rem; color: #555; }
      .meta { margin: 0.25rem 0 1rem 0; color: #555; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>AWS Service Graph</h1>
          <p class="meta">Region: ${regionInfo}</p>
        </div>
      </header>
      ${errorHtml}
      ${warningsHtml}
      <section id="validation">
        <header><h2>Validation</h2></header>
        ${validationHtml}
      </section>
      <section id="graph">
        <header><h2>Graph</h2></header>
        <div id="graph-root"></div>
      </section>
      <section id="json">
        <header><h2>Graph JSON</h2></header>
        <pre>${graphJsonEscaped}</pre>
      </section>
    </main>
    <footer>Service colors are hardcoded in the application and applied client-side.</footer>
    <script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
    <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
    <script src="https://unpkg.com/reactflow@11.10.0/dist/umd/index.js" crossorigin></script>
    <script>
      (function () {
        const graphData = ${scriptGraph};
        const serviceColors = ${scriptColors};

        function normalizeColor(color) {
          if (!color) return '#999999';
          if (color.startsWith('#') && (color.length === 7 || color.length === 4)) {
            return color;
          }
          return '#' + color.replace(/^#/, '');
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

        function computeLayout(graph) {
          const width = window.innerWidth || 1280;
          const height = window.innerHeight || 720;
          const simulationNodes = graph.nodes.map((node) => ({
            id: node.id,
            label: node.label ?? node.id,
            service: node.service ?? 'Unknown',
            x: Math.random() * width,
            y: Math.random() * height
          }));
          const simulationLinks = graph.edges.map((edge) => ({
            source: edge.source,
            target: edge.target
          }));

          if (simulationNodes.length === 0) {
            return { nodes: [], edges: [] };
          }

          const forceSim = window.d3.forceSimulation(simulationNodes)
            .force('link', window.d3.forceLink(simulationLinks).id((d) => d.id).distance(200).strength(0.2))
            .force('charge', window.d3.forceManyBody().strength(-600))
            .force('center', window.d3.forceCenter(width / 2, height / 2))
            .force('collision', window.d3.forceCollide().radius(90))
            .stop();

          for (let i = 0; i < 300; i += 1) {
            forceSim.tick();
          }

          const minX = Math.min(...simulationNodes.map((node) => node.x));
          const minY = Math.min(...simulationNodes.map((node) => node.y));
          const padding = 120;

          const laidOutNodes = simulationNodes.map((node) => ({
            id: node.id,
            label: node.label,
            service: node.service,
            position: {
              x: node.x - minX + padding,
              y: node.y - minY + padding
            }
          }));

          return { nodes: laidOutNodes, edges: graph.edges };
        }

        function buildReactFlowGraph(graph) {
          const layout = computeLayout(graph);

          const nodes = layout.nodes.map((node) => {
            const color = normalizeColor(serviceColors[node.service] || serviceColors.Unknown || '#999999');
            const textColor = pickTextColor(color);
            return {
              id: node.id,
              data: { label: node.label, service: node.service },
              position: node.position,
              style: {
                background: color,
                color: textColor,
                border: '1px solid #333',
                borderRadius: 8,
                padding: '10px 14px',
                fontSize: '14px',
                fontWeight: 500,
                width: 200,
                textAlign: 'center',
                boxShadow: '0 1px 3px rgba(0,0,0,0.15)'
              }
            };
          });

          const edges = layout.edges.map((edge, index) => ({
            id: 'edge-' + index,
            source: edge.source,
            target: edge.target,
            label: edge.type ? String(edge.type) : undefined,
            type: 'smoothstep',
            markerEnd: {
              type: window.ReactFlow.MarkerType.ArrowClosed,
              width: 20,
              height: 20,
              color: '#444'
            },
            labelBgPadding: [4, 2],
            labelBgBorderRadius: 4,
            labelBgStyle: { fill: 'rgba(33, 33, 33, 0.8)', color: '#fff' },
            animated: false
          }));

          return { nodes, edges };
        }

        function mountReactFlow() {
          const rootElement = document.getElementById('graph-root');
          if (!rootElement) {
            return;
          }

          if (!window.React || !window.ReactDOM || !window.ReactFlow || !window.d3) {
            rootElement.innerHTML = '<p style="padding:1rem;">Failed to load required visualization libraries.</p>';
            return;
          }

          const {
            ReactFlow: ReactFlowComponent,
            ReactFlowProvider,
            Background,
            Controls,
            MiniMap,
            useNodesState,
            useEdgesState,
            ConnectionMode,
            Panel
          } = window.ReactFlow;

          const { createElement, useMemo, useState, useEffect, useRef } = window.React;
          const { createRoot } = window.ReactDOM;

          function GraphApp() {
            const reactFlowInstanceRef = useRef(null);
            const focusedNodeRef = useRef(null);

            const allServices = useMemo(() => {
              const serviceSet = new Set();
              graphData.nodes.forEach((node) => {
                serviceSet.add(node.service || 'Unknown');
              });
              return Array.from(serviceSet).sort((a, b) => a.localeCompare(b));
            }, []);

            const initialVisibility = useMemo(() => {
              const defaults = {};
              const disabledByDefault = new Set(['IAM', 'Layer', 'VPC']);
              allServices.forEach((service) => {
                defaults[service] = disabledByDefault.has(service) ? false : true;
              });
              return defaults;
            }, [allServices]);

            const [visibleServices, setVisibleServices] = useState(initialVisibility);
            const [nodes, setNodes, onNodesChange] = useNodesState([]);
            const [edges, setEdges, onEdgesChange] = useEdgesState([]);
            const [searchTerm, setSearchTerm] = useState('');
            const [focusedNodeId, setFocusedNodeId] = useState(null);

            const filteredGraph = useMemo(() => {
              const enabledServices = new Set();
              allServices.forEach((service) => {
                if (visibleServices[service] !== false) {
                  enabledServices.add(service);
                }
              });

              const visibleNodes = graphData.nodes.filter((node) => enabledServices.has(node.service || 'Unknown'));
              const allowedIds = new Set(visibleNodes.map((node) => node.id));
              const visibleEdges = graphData.edges.filter((edge) => allowedIds.has(edge.source) && allowedIds.has(edge.target));
              return { nodes: visibleNodes, edges: visibleEdges };
            }, [allServices, visibleServices]);

            useEffect(() => {
              if (focusedNodeRef.current && !filteredGraph.nodes.some((node) => node.id === focusedNodeRef.current)) {
                focusedNodeRef.current = null;
                setFocusedNodeId(null);
              }

              const layout = buildReactFlowGraph(filteredGraph);
              const selectedId = focusedNodeRef.current;
              setNodes(layout.nodes.map((node) => ({
                ...node,
                selected: selectedId ? node.id === selectedId : false
              })));
              setEdges(layout.edges);
            }, [filteredGraph, setNodes, setEdges]);

            const searchMatches = useMemo(() => {
              const term = searchTerm.trim().toLowerCase();
              if (!term) {
                return [];
              }

              return filteredGraph.nodes
                .map((node) => ({
                  id: node.id,
                  label: node.label || node.id,
                  service: node.service || 'Unknown'
                }))
                .filter((node) => {
                  return node.label.toLowerCase().includes(term) || node.id.toLowerCase().includes(term);
                })
                .slice(0, 15);
            }, [searchTerm, filteredGraph]);

            function focusNode(nodeId) {
              if (!nodeId) {
                return;
              }

              focusedNodeRef.current = nodeId;
              setFocusedNodeId(nodeId);
              setNodes((existingNodes) => existingNodes.map((node) => ({
                ...node,
                selected: node.id === nodeId
              })));

              window.requestAnimationFrame(() => {
                const instance = reactFlowInstanceRef.current;
                if (!instance) {
                  return;
                }
                const targetNode = instance.getNode(nodeId);
                if (!targetNode) {
                  return;
                }
                instance.fitView({ nodes: [{ id: nodeId }], padding: 0.25, duration: 800, minZoom: 0.08 });
              });
            }

            function toggleService(service) {
              setVisibleServices((prev) => ({
                ...prev,
                [service]: prev[service] === false ? true : false
              }));
            }

            function handleSearchKeyDown(event) {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (searchMatches.length > 0) {
                  focusNode(searchMatches[0].id);
                }
              }
            }

            const controlsContent = [];

            controlsContent.push(
              createElement(
                'div',
                {
                  key: 'search-container',
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px'
                  }
                },
                createElement('label', { htmlFor: 'graph-search', style: { fontWeight: 600 } }, 'Search nodes'),
                createElement(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      gap: '6px'
                    }
                  },
                  createElement('input', {
                    id: 'graph-search',
                    type: 'search',
                    value: searchTerm,
                    placeholder: 'Search nodes (name or ARN)…',
                    onChange: (event) => setSearchTerm(event.target.value),
                    onKeyDown: handleSearchKeyDown,
                    style: {
                      flex: 1,
                      padding: '6px 8px',
                      borderRadius: 6,
                      border: '1px solid #c8c8c8',
                      fontSize: '13px'
                    }
                  }),
                  searchTerm
                    ? createElement('button', {
                        type: 'button',
                        onClick: () => setSearchTerm(''),
                        style: {
                          border: '1px solid #c8c8c8',
                          borderRadius: 6,
                          padding: '6px 10px',
                          background: '#f2f2f2',
                          cursor: 'pointer'
                        }
                      }, 'Clear')
                    : null
                ),
                searchTerm && searchMatches.length === 0
                  ? createElement('div', { style: { fontSize: '12px', color: '#9a0000' } }, 'No matching nodes.')
                  : null,
                searchMatches.length > 0
                  ? createElement(
                      'ul',
                      {
                        style: {
                          listStyle: 'none',
                          padding: 0,
                          margin: 0,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '4px'
                        }
                      },
                      ...searchMatches.map((match) => {
                        const isFocused = match.id === focusedNodeId;
                        const color = normalizeColor(serviceColors[match.service] || serviceColors.Unknown || '#999999');
                        return createElement(
                          'li',
                          { key: 'search-' + match.id },
                          createElement(
                            'button',
                            {
                              type: 'button',
                              onClick: () => focusNode(match.id),
                              style: {
                                width: '100%',
                                textAlign: 'left',
                                borderRadius: 6,
                                border: isFocused ? '2px solid #2e73b8' : '1px solid #d0d0d0',
                                padding: '6px 8px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '2px',
                                background: isFocused ? 'rgba(46,115,184,0.08)' : '#fff',
                                cursor: 'pointer'
                              }
                            },
                            createElement('span', { style: { fontSize: '13px', fontWeight: 600 } }, match.label),
                            createElement(
                              'span',
                              {
                                style: {
                                  fontSize: '11px',
                                  color: '#555',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '6px'
                                }
                              },
                              createElement('span', {
                                style: {
                                  width: '10px',
                                  height: '10px',
                                  borderRadius: '50%',
                                  background: color,
                                  border: '1px solid rgba(0,0,0,0.2)'
                                }
                              }),
                              match.service,
                              ' • ',
                              match.id
                            )
                          )
                        );
                      })
                    )
                  : null
              )
            );

            controlsContent.push(
              createElement(
                'strong',
                { key: 'summary' },
                'Nodes: ' + filteredGraph.nodes.length + ' • Edges: ' + filteredGraph.edges.length
              )
            );
            controlsContent.push(
              createElement('span', { key: 'hint', style: { fontSize: '12px', color: '#555' } }, 'Toggle services to show or hide them.')
            );

            allServices.forEach((service) => {
              const color = normalizeColor(serviceColors[service] || serviceColors.Unknown || '#999999');
              controlsContent.push(
                createElement(
                  'label',
                  {
                    key: 'svc-' + service,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '4px 0'
                    }
                  },
                  createElement('input', {
                    type: 'checkbox',
                    checked: visibleServices[service] !== false,
                    onChange: () => toggleService(service)
                  }),
                  createElement(
                    'span',
                    {
                      style: {
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.35rem'
                      }
                    },
                    createElement('span', {
                      style: {
                        width: '12px',
                        height: '12px',
                        borderRadius: '50%',
                        background: color,
                        border: '1px solid rgba(0,0,0,0.25)'
                      }
                    }),
                    service
                  )
                )
              );
            });

            const controlStyle = {
              background: 'rgba(255,255,255,0.95)',
              padding: '10px 12px',
              borderRadius: 8,
              boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
              fontSize: '13px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              maxHeight: '70vh',
              overflowY: 'auto',
              minWidth: '250px'
            };

            const panelInReactFlow = Panel
              ? createElement(Panel, { position: 'top-left', style: controlStyle }, ...controlsContent)
              : null;

            const fallbackPanel = Panel
              ? null
              : createElement('div', { style: { ...controlStyle, position: 'absolute', left: '16px', top: '16px' } }, ...controlsContent);

            return createElement(
              'div',
              { style: { width: '100%', height: '100%', position: 'relative' } },
              createElement(
                ReactFlowComponent,
                {
                  nodes,
                  edges,
                  onNodesChange,
                  onEdgesChange,
                  nodesDraggable: true,
                  nodesConnectable: false,
                  panOnScroll: true,
                  connectionMode: ConnectionMode.Loose,
                  fitView: true,
                  fitViewOptions: { padding: 0.15 },
                  minZoom: 0.05,
                  maxZoom: 3,
                  onInit: (instance) => {
                    reactFlowInstanceRef.current = instance;
                  }
                },
                createElement(Background, { gap: 24, color: '#e2e2e2' }),
                createElement(Controls, null),
                createElement(MiniMap, {
                  nodeColor: (node) => node.style?.background || '#999999'
                }),
                panelInReactFlow
              ),
              fallbackPanel
            );
          }

          const root = createRoot(rootElement);
          root.render(
            createElement(
              ReactFlowProvider,
              null,
              createElement(GraphApp, null)
            )
          );
        }

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', mountReactFlow);
        } else {
          mountReactFlow();
        }
      })();
    </script>
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
      graph: { nodes: [], edges: [] },
      validationSteps: [{ action: 'runtime', status: 'failure', message }],
      error: message,
      warnings: [],
      serviceColorsMap: serviceColors
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

  const html = buildHtmlPage({
    graph: result.graph,
    validationSteps,
    error: result.error,
    warnings: result.warnings,
    serviceColorsMap: serviceColors
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
