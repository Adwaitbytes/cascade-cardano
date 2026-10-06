"use client";

import { AlertTriangle, CheckCircle2, Loader2, Wallet, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useState, type ReactNode } from "react";
import { Address } from "@/components/address";
import { Amount } from "@/components/amount";
import { TxLink } from "@/components/tx-link";
import { Button } from "@/components/ui/button";
import { getDataSource } from "@/lib/api";
import type { TxPreview } from "@/lib/api/schemas";
import { connectWallet, listWallets, type ConnectedWallet, type InstalledWallet } from "@/lib/wallet/cip30";

type Step =
  | { kind: "review" }
  | { kind: "wallets"; wallets: InstalledWallet[] | null }
  | { kind: "building" }
  | { kind: "confirm"; wallet: ConnectedWallet; txCbor: string; preview: TxPreview; problems: string[] }
  | { kind: "signing" }
  | { kind: "done"; txId: string }
  | { kind: "error"; message: string };

export interface SignFlowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Plain words, shown before anything is signed (PRD 14.7). */
  sentence: string;
  details?: ReactNode;
  /** Label of the final action, e.g. "Sign and fund". */
  actionLabel: string;
  build: (wallet: ConnectedWallet) => Promise<string>;
  /** Compares the decoded transaction with what the user approved; any problem blocks signing. */
  verify?: (preview: TxPreview) => string[];
  /** Plain names for addresses the flow recognises, e.g. "Cascade root" or "Your wallet". */
  labelAddress?: (address: string, wallet: ConnectedWallet) => string | null;
  /** Plain names for non-fungible protocol tokens, e.g. "thread token". */
  labelAsset?: (asset: string) => string | null;
  onSubmitted?: (txId: string) => void;
  doneBody?: (txId: string) => ReactNode;
}

export function SignFlow({ open, onOpenChange, title, sentence, details, actionLabel, build, verify, labelAddress, labelAsset, onSubmitted, doneBody }: SignFlowProps) {
  const [step, setStep] = useState<Step>({ kind: "review" });

  const reset = (next: boolean): void => {
    onOpenChange(next);
    if (!next) setStep({ kind: "review" });
  };

  const chooseWallet = async (): Promise<void> => {
    setStep({ kind: "wallets", wallets: null });
    try {
      setStep({ kind: "wallets", wallets: await listWallets() });
    } catch (e) {
      setStep({ kind: "error", message: `Could not look for wallets: ${(e as Error).message}` });
    }
  };

  const pickWallet = async (id: string): Promise<void> => {
    setStep({ kind: "building" });
    try {
      const wallet = await connectWallet(id);
      const txCbor = await build(wallet);
      const preview = await (await getDataSource()).previewTx(txCbor);
      setStep({ kind: "confirm", wallet, txCbor, preview, problems: verify?.(preview) ?? [] });
    } catch (e) {
      setStep({ kind: "error", message: (e as Error).message });
    }
  };

  const sign = async (wallet: ConnectedWallet, txCbor: string): Promise<void> => {
    setStep({ kind: "signing" });
    try {
      const signed = await wallet.signTx(txCbor);
      const txId = await wallet.submitTx(signed);
      setStep({ kind: "done", txId });
      onSubmitted?.(txId);
    } catch (e) {
      setStep({ kind: "error", message: `The transaction was not submitted: ${(e as Error).message}` });
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={reset}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_160ms_ease-out]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-24px)] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop data-[state=open]:animate-[rise_220ms_var(--ease-out-quint)]" data-testid="sign-flow">
          <div className="shrink-0 border-b border-line px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <Dialog.Title className="text-[0.8125rem] font-semibold text-ink-3">{title}</Dialog.Title>
              <Dialog.Close className="-mt-1 -mr-1 rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Close">
                <X className="size-4" />
              </Dialog.Close>
            </div>
            <Dialog.Description asChild>
              <p className="mt-1 text-lg leading-snug font-semibold tracking-tight text-pretty break-words" data-testid="plain-preview">
                {sentence}.
              </p>
            </Dialog.Description>
          </div>
          <div className="grid min-h-0 min-w-0 flex-1 gap-4 overflow-y-auto overscroll-contain px-5 py-5">
            {details}

            {step.kind === "review" ? (
              <Button size="lg" onClick={chooseWallet}>
                <Wallet /> Connect a preprod wallet
              </Button>
            ) : null}

            {step.kind === "wallets" ? (
              step.wallets === null ? (
                <p className="flex items-center gap-2 text-sm text-ink-2"><Loader2 className="size-4 animate-spin" /> Looking for wallets</p>
              ) : step.wallets.length === 0 ? (
                <p className="rounded-lg border border-line bg-surface-2 p-3 text-sm text-ink-2" role="alert">
                  No Cardano wallet found in this browser. Install Eternl, Lace or Yoroi, switch it to preprod, then reload this page.
                </p>
              ) : (
                <ul className="grid gap-2">
                  {step.wallets.map((w) => (
                    <li key={w.id}>
                      <button type="button" onClick={() => void pickWallet(w.id)} className="flex w-full items-center gap-3 rounded-lg border border-line-strong px-3 py-2.5 text-left text-sm font-medium hover:bg-surface-2">
                        {w.icon.startsWith("data:image/") ? <img src={w.icon} alt="" className="size-6 rounded" /> : <Wallet className="size-6 text-ink-3" aria-hidden />}
                        {w.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : null}

            {step.kind === "building" ? <p className="flex items-center gap-2 text-sm text-ink-2"><Loader2 className="size-4 animate-spin" /> Building the transaction and decoding it</p> : null}

            {step.kind === "confirm" ? (
              <div className="grid gap-3">
                <div className="rounded-xl border border-line bg-surface-2 p-4">
                  <p className="text-[0.8125rem] font-medium text-ink-3">The indexer decoded the unsigned transaction as</p>
                  <p className="mt-1 text-sm font-medium">{step.preview.summary}</p>
                  <ul className="mt-3 grid gap-1.5 text-sm" data-testid="tx-moves">
                    {step.preview.moves.map((m, i) => (
                      <li key={i} className="flex min-w-0 items-center justify-between gap-3">
                        <Address value={m.to} label={labelAddress?.(m.to, step.wallet) ?? null} className="text-[0.8125rem]" />
                        {labelAsset?.(m.value.asset) != null ? (
                          <span className="shrink-0 font-semibold" title={m.value.asset}>{m.value.amount} {labelAsset(m.value.asset)}</span>
                        ) : (
                          <Amount value={m.value.amount} asset={m.value.asset} className="shrink-0 font-semibold" />
                        )}
                      </li>
                    ))}
                  </ul>
                  {step.preview.warnings?.map((w) => <p key={w} className="mt-2 text-sm text-working">{w}</p>)}
                </div>
              </div>
            ) : null}

            {step.kind === "signing" ? <p className="flex items-center gap-2 text-sm text-ink-2"><Loader2 className="size-4 animate-spin" /> Waiting for your wallet</p> : null}

            {step.kind === "done" ? (
              <div className="grid gap-3">
                <p className="flex items-center gap-2 font-semibold text-accepted"><CheckCircle2 className="size-5" /> Submitted to preprod</p>
                <p className="text-sm text-ink-2">Transaction <TxLink txId={step.txId} /></p>
                {doneBody?.(step.txId)}
              </div>
            ) : null}

            {step.kind === "error" ? (
              <div className="grid gap-3">
                <p className="rounded-lg border border-challenged/40 bg-challenged-bg p-3 text-sm text-challenged" role="alert">{step.message}</p>
                <Button variant="secondary" onClick={() => setStep({ kind: "review" })}>Start again</Button>
              </div>
            ) : null}
          </div>
          {step.kind === "confirm" ? (
            <div className="grid shrink-0 gap-3 border-t border-line bg-surface px-5 py-4" data-testid="sign-footer">
              {step.problems.length > 0 ? (
                <div className="max-h-40 overflow-y-auto rounded-xl border border-challenged/40 bg-challenged-bg p-3.5 text-sm text-challenged" role="alert">
                  <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4 shrink-0" /> This transaction does not match what you approved. Signing is blocked.</p>
                  <ul className="mt-2 list-disc pl-5">{step.problems.map((p) => <li key={p}>{p}</li>)}</ul>
                </div>
              ) : null}
              <Button size="lg" disabled={step.problems.length > 0} onClick={() => void sign(step.wallet, step.txCbor)}>
                {actionLabel}
              </Button>
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
