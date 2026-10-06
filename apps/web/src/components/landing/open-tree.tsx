"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";

export function OpenTree() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const id = value.trim().toLowerCase();
    if (!/^[0-9a-f]{56}$/.test(id)) {
      setError("A tree id is 56 hex characters, the root token name.");
      return;
    }
    router.push(`/tree/${id}`);
  };
  return (
    <form onSubmit={submit} className="grid gap-1.5" noValidate>
      <label htmlFor="tree-id" className="text-[0.8125rem] font-medium">Open any tree by id</label>
      <div className="flex gap-2">
        <Input id="tree-id" value={value} onChange={(e) => { setValue(e.target.value); setError(null); }} placeholder="56 hex characters" className="font-mono text-xs" spellCheck={false} aria-invalid={error !== null || undefined} aria-describedby={error !== null ? "tree-id-error" : undefined} />
        <Button type="submit" variant="secondary">Open</Button>
      </div>
      {error !== null ? <p id="tree-id-error" role="alert" className="text-[0.8125rem] text-challenged">{error}</p> : null}
    </form>
  );
}
