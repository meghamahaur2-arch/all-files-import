import { createFileRoute } from "@tanstack/react-router";
import { getEncryptedDomainRecordById } from "@/lib/server/paymemo-db";

/**
 * Public invoice view. Anyone with the invoice id can read this, so we
 * deliberately whitelist a minimal set of fields. We never return the
 * raw `publicData` blob — a frontend bug that stuffs personal info
 * into publicData would otherwise leak it to the entire internet.
 */
function pickPublic(publicData: Record<string, unknown>) {
  const addr = (key: string) => {
    const value = String(publicData[key] ?? "").toLowerCase();
    return /^0x[a-f0-9]{40}$/.test(value) ? value : null;
  };
  const text = (key: string, max = 200) => {
    const value = publicData[key];
    if (typeof value !== "string") return null;
    return value.length > max ? value.slice(0, max) : value;
  };
  const num = (key: string) => {
    const value = publicData[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return null;
  };
  return {
    payee: addr("payee"),
    payer: addr("payer"),
    amount: text("amount", 64),
    token: text("token", 24),
    tokenContract: addr("tokenContract"),
    tokenDecimals: num("tokenDecimals"),
    chainId: num("chainId"),
    dueDate: text("dueDate", 32),
    invoiceNumber: text("invoiceNumber", 64),
    memo: text("memo", 400),
    linkedTxHash: text("linkedTxHash", 80),
    paidAt: text("paidAt", 32),
  };
}

export const Route = createFileRoute("/api/public-invoice")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        const id = url.searchParams.get("id");

        if (!id) {
          return Response.json({ error: "Missing invoice id" }, { status: 400 });
        }

        const invoice = await getEncryptedDomainRecordById(id, "invoice");
        if (!invoice) {
          return Response.json({ error: "Invoice not found" }, { status: 404 });
        }

        if (invoice.status === "draft" || invoice.status === "cancelled") {
          return Response.json({ error: "Invoice not available" }, { status: 404 });
        }

        return Response.json({
          ok: true,
          invoice: {
            id: invoice.id,
            status: invoice.status,
            createdAt: invoice.createdAt,
            publicData: pickPublic(invoice.publicData ?? {}),
          },
        });
      },
    },
  },
});
