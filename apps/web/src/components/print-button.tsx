"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Opens the browser's print dialog; "Save as PDF" there gives the receipt as a document. */
export function PrintButton() {
  return (
    <Button variant="secondary" size="sm" className="no-print" onClick={() => window.print()}>
      <Printer /> Save as PDF
    </Button>
  );
}
