import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  getEncryptedDomainRecordById,
  patchEncryptedDomainRecordPublicData,
} from "@/lib/server/paymemo-db";
import { morphHoodi } from "@/lib/morph";
import { checkRateLimit } from "@/lib/server/rate-limit";

const invoicePaymentSchema = z.object({
  invoiceId: z.string().min(1),
  txHash: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/u, "txHash must be a 0x-prefixed 32-byte hex value"),
  payer: z.string().regex(/^0x[a-fA-F0-9]{40}$/u, "payer must be a 0x EVM address"),
  chainId: z.number().default(2910),
});

type MorphTransaction = {
  hash: string;
  from?: string;
  to?: string;
  value?: string;
  input?: string;
};

type MorphReceipt = {
  status?: string;
  to?: string;
  from?: string;
};

const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

async function morphRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(morphHoodi.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });

  if (!response.ok) throw new Error(`Morph RPC error ${response.status}`);
  const payload = (await response.json()) as { result?: T; error?: { message?: string } };
  if (payload.error) throw new Error(payload.error.message || "Morph RPC error");
  return payload.result as T;
}

function hexToBigInt(value: string | undefined) {
  if (!value || value === "0x") return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function parseTokenUnits(amount: string, decimals: number) {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  try {
    return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(paddedFraction || "0");
  } catch {
    return null;
  }
}

function decodeErc20TransferData(data: string) {
  const value = String(data || "").toLowerCase();
  if (!value.startsWith(ERC20_TRANSFER_SELECTOR) || value.length < 138) return null;
  const recipient = `0x${value.slice(34, 74).slice(-40)}`;
  const amount = hexToBigInt(`0x${value.slice(74, 138)}`);
  return { recipient, amount };
}

export const Route = createFileRoute("/api/invoice-payment")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const limited = checkRateLimit(request, { scope: "invoice-payment-post", limit: 20 });
        if (!limited.ok) return limited.response;

        const body = await request.json().catch(() => null);
        const parsed = invoicePaymentSchema.safeParse(body);

        if (!parsed.success) {
          return Response.json(
            { error: "Invalid invoice payment payload", issues: parsed.error.flatten() },
            { status: 400 },
          );
        }

        const invoice = await getEncryptedDomainRecordById(parsed.data.invoiceId, "invoice");
        if (!invoice) {
          return Response.json({ error: "Invoice not found" }, { status: 404 });
        }

        if (invoice.status === "paid") {
          return Response.json({ error: "Invoice already marked paid", invoice }, { status: 409 });
        }

        if (invoice.status === "cancelled") {
          return Response.json({ error: "Invoice is cancelled" }, { status: 409 });
        }

        if (parsed.data.chainId !== morphHoodi.chainId) {
          return Response.json(
            { error: `Unsupported chain ${parsed.data.chainId}. Expected Morph Hoodi.` },
            { status: 400 },
          );
        }

        let tx: MorphTransaction | null = null;
        let receipt: MorphReceipt | null = null;
        try {
          [tx, receipt] = await Promise.all([
            morphRpc<MorphTransaction | null>("eth_getTransactionByHash", [parsed.data.txHash]),
            morphRpc<MorphReceipt | null>("eth_getTransactionReceipt", [parsed.data.txHash]),
          ]);
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Morph RPC verification failed" },
            { status: 502 },
          );
        }

        if (!tx || !receipt) {
          return Response.json(
            { error: "Transaction not found on Morph Hoodi yet" },
            { status: 404 },
          );
        }

        if (receipt.status !== "0x1") {
          return Response.json({ error: "Transaction did not succeed onchain" }, { status: 400 });
        }

        const expectedPayee = String(invoice.publicData.payee ?? "").toLowerCase();
        const expectedAmount = String(invoice.publicData.amount ?? "");
        const expectedToken = String(invoice.publicData.token ?? "ETH").toUpperCase();
        const expectedTokenContract = String(invoice.publicData.tokenContract ?? "").toLowerCase();
        const rawDecimals = Number(invoice.publicData.tokenDecimals);
        const expectedTokenDecimals =
          Number.isFinite(rawDecimals) && rawDecimals >= 0 && rawDecimals <= 36 ? rawDecimals : 18;
        const txFrom = String(tx.from ?? "").toLowerCase();
        const txTo = String(tx.to ?? "").toLowerCase();
        const claimedPayer = parsed.data.payer.toLowerCase();

        if (!expectedPayee || !/^0x[a-f0-9]{40}$/.test(expectedPayee)) {
          return Response.json({ error: "Invoice payee is not a valid address" }, { status: 422 });
        }

        if (txFrom !== claimedPayer) {
          return Response.json(
            { error: "Transaction sender does not match the claimed payer" },
            { status: 400 },
          );
        }

        if (expectedToken === "ETH") {
          const expectedValue = parseTokenUnits(expectedAmount, 18);
          if (expectedValue === null) {
            return Response.json({ error: "Invoice amount is invalid" }, { status: 422 });
          }
          if (txTo !== expectedPayee) {
            return Response.json(
              { error: "Transaction recipient does not match invoice payee" },
              { status: 400 },
            );
          }
          if (hexToBigInt(tx.value) !== expectedValue) {
            return Response.json(
              { error: "Transaction amount does not match invoice" },
              { status: 400 },
            );
          }
        } else {
          // For ERC-20 invoices, the invoice MUST commit to a specific
          // token contract address. Without it, a payer could pay 1 wei
          // of any (or a worthless fake) token and pass verification.
          if (!/^0x[a-f0-9]{40}$/.test(expectedTokenContract)) {
            return Response.json(
              {
                error: "Invoice is missing tokenContract; cannot verify an ERC-20 payment safely.",
              },
              { status: 422 },
            );
          }
          if (txTo !== expectedTokenContract) {
            return Response.json(
              { error: "Transaction did not call the expected token contract" },
              { status: 400 },
            );
          }
          const decoded = decodeErc20TransferData(tx.input ?? "");
          if (!decoded) {
            return Response.json(
              { error: "Transaction is not a recognized ERC-20 transfer" },
              { status: 400 },
            );
          }
          if (decoded.recipient.toLowerCase() !== expectedPayee) {
            return Response.json(
              { error: "ERC-20 recipient does not match invoice payee" },
              { status: 400 },
            );
          }
          const expectedValue = parseTokenUnits(expectedAmount, expectedTokenDecimals);
          if (expectedValue === null) {
            return Response.json({ error: "Invoice amount is invalid" }, { status: 422 });
          }
          if (decoded.amount !== expectedValue) {
            return Response.json(
              { error: "ERC-20 transfer amount does not match invoice" },
              { status: 400 },
            );
          }
        }

        const updated = await patchEncryptedDomainRecordPublicData(
          parsed.data.invoiceId,
          "invoice",
          {
            status: "paid",
            publicData: {
              linkedTxHash: parsed.data.txHash,
              payer: claimedPayer,
              paidAt: new Date().toISOString(),
              chainId: parsed.data.chainId,
            },
          },
        );

        return Response.json({ ok: true, invoice: updated });
      },
    },
  },
});
