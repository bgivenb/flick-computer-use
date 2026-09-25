import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function fixture(outboundUrl?: string) {
  let saved: unknown = null;
  const html = `<!doctype html><html><head><title>Local automation lab</title><style>
  body{font:18px system-ui;max-width:760px;margin:60px auto;background:#f4f6f8;color:#172333}h1{font-size:36px}button,input,select{font:inherit;padding:12px;margin:8px 0}label{display:block;margin:16px 0}section{background:white;padding:30px;border-radius:16px}button{cursor:pointer}small{color:#59687c}
  </style></head><body><h1>Local automation lab</h1><p>Disposable controls for testing Jev. No external account.</p>
  <section id="home"><h2>Workspace</h2><button id="open">Export settings</button></section>
  <section id="settings" hidden><h2>Export settings</h2><form id="form">
  <label>Contact email <input id="email" type="email" name="email" required></label>
  <label>Export format <select id="format" name="format"><option value="json">JSON</option><option value="csv">CSV</option></select></label>
  <label><input id="headers" type="checkbox" name="headers"> Include column headers</label>
  <button type="submit">Save settings</button></form><p id="status" role="status">Changes have not been saved.</p></section>
  <p><small>Browser control and model decisions are timed separately.</small></p>
  <script>
  document.getElementById('open').onclick=()=>{document.getElementById('home').hidden=true;document.getElementById('settings').hidden=false};
  document.getElementById('form').onsubmit=async event=>{event.preventDefault();const state={email:document.getElementById('email').value,format:document.getElementById('format').value,headers:document.getElementById('headers').checked};await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(state)});document.getElementById('status').textContent='Export settings saved';};
  </script></body></html>`;
  const server = createServer(async (request, response) => {
    if (request.url === '/save' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      saved = JSON.parse(body); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}');
    } else if (request.url === '/state') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(saved)); }
    else if (request.url === '/outbound' && outboundUrl) {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><title>Outbound link</title><a href="${outboundUrl}">Open other site</a>`);
    }
    else if (request.url === '/edges') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><title>Edge cases</title><label>Visible input<input id="visible"></label><input aria-label="Hidden input" hidden><input type="password" aria-label="Password" value="do-not-expose"><div id="shadow"></div><iframe src="/frame"></iframe><img alt="Test illustration" width="160" height="100" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='100'%3E%3Crect width='160' height='100' fill='blue'/%3E%3C/svg%3E"><script>document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow action</button>'</script>`);
    } else if (request.url === '/frame') { response.setHeader('Content-Type', 'text/html'); response.end('<button>Frame action</button>'); }
    else if (request.url === '/clipped') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><title>Clipped link</title><style>
      .skip { position:absolute; top:10px; left:10px; padding:12px; clip:rect(1px,1px,1px,1px); }
      </style><a class="skip" href="#main">Skip to main content</a><main id="main"><button>Open results</button></main>`);
    }
    else if (request.url === '/live') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><title>Live results</title><p id="clock">0</p><label>Search <input id="q"></label><button id="go">Search</button><p id="status"></p><script>
      let n = 0; setInterval(() => { document.getElementById('clock').textContent = 'Updated ' + (++n); }, 30);
      const status = text => { document.getElementById('status').textContent = text; };
      document.getElementById('go').onclick = () => status('Searched ' + document.getElementById('q').value);
      document.getElementById('q').onkeydown = event => { if (event.key === 'Enter') status('Submitted ' + event.target.value); };</script>`);
    }
    else if (request.url === '/recovery') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><title>Recovery start</title><a href="/recovery-next">Next page</a>
        <p id="late">Waiting for data</p><img alt="Late illustration" src="/slow-image">
        <script>setTimeout(() => { document.getElementById('late').textContent = 'Results are ready'; }, 350)</script>`);
    }
    else if (request.url === '/slow-image') {
      await new Promise(resolve => setTimeout(resolve, 650));
      response.setHeader('Content-Type', 'image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>');
    }
    else if (request.url === '/recovery-next') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Recovery destination</title><p>Next page arrived</p>');
    }
    else if (request.url === '/long-page') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Long page</title><div style="height:2400px">Top of page</div><p>Bottom of page</p>');
    }
    else { response.setHeader('Content-Type', 'text/html'); response.end(html); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state: () => saved,
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
