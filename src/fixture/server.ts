import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type Invoice = {
  id: number;
  number: string;
  customer: string;
  status: "draft" | "pending";
  totalCents: number;
  createdAt: string;
};

type LineItem = {
  id: number;
  invoiceId: number;
  description: string;
  quantity: number;
  unitPriceCents: number;
};

export type FixtureServer = {
  url: string;
  close(): Promise<void>;
};

export async function startFixtureServer(
  port = 0,
  databaseWriteDelayMs = 0,
  variant: "reference" | "divergent" = "reference",
): Promise<FixtureServer> {
  let invoices: Invoice[] = [];
  let lineItems: LineItem[] = [];
  let nextInvoiceId = 1;
  let nextLineItemId = 1;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://fixture.local");
      if (request.method === "GET" && url.pathname === "/") return html(response, fixtureHtml);
      if (request.method === "GET" && url.pathname === "/api/invoices") {
        return json(response, 200, { invoices, lineItems });
      }
      if (request.method === "POST" && url.pathname === "/api/invoices") {
        const body = await readJson(request);
        const customer = requiredString(body.customer, "customer");
        const description = requiredString(body.description, "description");
        const quantity = positiveInteger(body.quantity, "quantity");
        const unitPriceCents = positiveInteger(body.unitPriceCents, "unitPriceCents");
        const invoiceId = nextInvoiceId++;
        const invoice: Invoice = {
          id: invoiceId,
          number: `INV-${String(invoiceId).padStart(4, "0")}`,
          customer,
          status: variant === "divergent" ? "pending" : "draft",
          totalCents: quantity * unitPriceCents + (variant === "divergent" ? 1 : 0),
          createdAt: "2026-01-01T00:00:00.000Z",
        };
        const lineItem: LineItem = {
          id: nextLineItemId++,
          invoiceId,
          description,
          quantity,
          unitPriceCents,
        };
        const persist = () => {
          invoices = [...invoices, invoice];
          lineItems = [...lineItems, lineItem];
        };
        if (databaseWriteDelayMs > 0) setTimeout(persist, databaseWriteDelayMs);
        else persist();
        return json(response, variant === "divergent" ? 200 : 201, { invoice, lineItems: [lineItem] });
      }
      if (request.method === "GET" && url.pathname === "/__fixture/db-snapshot") {
        return json(response, 200, { tables: { invoices, line_items: lineItems } });
      }
      if (request.method === "POST" && url.pathname === "/__fixture/reset") {
        invoices = [];
        lineItems = [];
        nextInvoiceId = 1;
        nextLineItemId = 1;
        return json(response, 200, { ok: true });
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind to a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function html(response: ServerResponse, value: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(value),
  });
  response.end(value);
}

const fixtureHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Invoice Fixture</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; background: #f4f2ec; color: #17201d; }
      main { max-width: 680px; margin: 4rem auto; padding: 2.5rem; background: white; border-radius: 18px; box-shadow: 0 18px 60px #23352b22; }
      h1 { margin-top: 0; }
      label { display: grid; gap: .4rem; margin: 1rem 0; font-weight: 650; }
      input { padding: .75rem; border: 1px solid #9ca9a2; border-radius: 8px; font: inherit; }
      button { margin-top: 1rem; padding: .8rem 1.1rem; border: 0; border-radius: 9px; background: #174f3a; color: white; font-weight: 700; }
      #result { margin-top: 1.5rem; padding: 1rem; background: #e9f6ee; border-radius: 10px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Create invoice</h1>
      <form id="invoice-form">
        <label>Customer <input name="customer" required></label>
        <label>Description <input name="description" required></label>
        <label>Quantity <input name="quantity" type="number" min="1" value="1" required></label>
        <label>Unit price in cents <input name="unitPriceCents" type="number" min="1" required></label>
        <button type="submit">Create invoice</button>
      </form>
      <section id="result" aria-live="polite" hidden></section>
    </main>
    <script>
      const form = document.querySelector('#invoice-form');
      const result = document.querySelector('#result');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(form));
        values.quantity = Number(values.quantity);
        values.unitPriceCents = Number(values.unitPriceCents);
        const response = await fetch('/api/invoices', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values)
        });
        const payload = await response.json();
        if (!response.ok) { result.textContent = payload.error; result.hidden = false; return; }
        result.innerHTML = '<h2>Invoice ' + payload.invoice.number + ' created</h2><p>Status: ' + payload.invoice.status + '</p>';
        result.hidden = false;
      });
      if (new URLSearchParams(location.search).get('autorun') === '1') {
        setTimeout(() => {
          const values = {
            customer: 'Manual Acme',
            description: 'Recorded by a human-style event journal',
            quantity: '3',
            unitPriceCents: '900'
          };
          for (const [name, value] of Object.entries(values)) {
            const field = form.elements.namedItem(name);
            field.value = value;
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
          }
          form.querySelector('button').click();
        }, 400);
      }
    </script>
  </body>
</html>`;
