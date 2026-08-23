// The one invoice that carries the whole page's narrative: Hero's document
// mock and the how-it-works pipeline sequence both show the *same*
// INV-2026-0007 from Dunmore Hardware Co., not two different made-up
// examples -- so someone scrolling from the hero into how-it-works
// recognizes it as the same document being walked through, not a fresh
// unrelated illustration.
export const INVOICE = {
  number: "INV-2026-0007",
  vendor: "Dunmore Hardware Co.",
  date: "01/15/2026",
  total: "$54.00",
};

export const INVOICE_FIELDS = [
  { key: "vendor", label: "VENDOR_NAME", value: "Dunmore Hardware Co.", conf: 98, flag: false },
  { key: "po", label: "PO_REFERENCE", value: "PO-4421", conf: 96, flag: false },
  { key: "due", label: "DUE_DATE", value: "02/14/2026", conf: 61, flag: true },
  { key: "tax", label: "TAX", value: "$4.00", conf: 94, flag: false },
];
