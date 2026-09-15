import { describe, expect, test } from "bun:test";

describe("UI Components Import and Export Integrity", () => {
  test("all 25+ component modules can be imported from index", async () => {
    const mod = await import("../../components/ui/index");
    expect(mod).toBeDefined();
  });

  test("Button exports Button and buttonVariants", async () => {
    const { Button, buttonVariants } = await import("../../components/ui/button");
    expect(typeof Button).toBe("function");
    expect(typeof buttonVariants).toBe("function");
  });

  test("Card exports Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter", async () => {
    const mod = await import("../../components/ui/card");
    expect(typeof mod.Card).toBe("function");
    expect(typeof mod.CardHeader).toBe("function");
    expect(typeof mod.CardTitle).toBe("function");
    expect(typeof mod.CardContent).toBe("function");
    expect(typeof mod.CardFooter).toBe("function");
  });

  test("Dialog exports Dialog, DialogContent with showCloseButton", async () => {
    const mod = await import("../../components/ui/dialog");
    expect(typeof mod.Dialog).toBe("function");
    expect(typeof mod.DialogContent).toBe("function");
  });

  test("Tabs exports TabsList and tabsListVariants", async () => {
    const mod = await import("../../components/ui/tabs");
    expect(typeof mod.TabsList).toBe("function");
    expect(typeof mod.tabsListVariants).toBe("function");
  });

  test("Table exports Table, TableHeader, TableBody, TableRow, TableHead, TableCell", async () => {
    const mod = await import("../../components/ui/table");
    expect(typeof mod.Table).toBe("function");
    expect(typeof mod.TableHeader).toBe("function");
    expect(typeof mod.TableBody).toBe("function");
  });

  test("Checkbox exports Checkbox", async () => {
    const mod = await import("../../components/ui/checkbox");
    expect(typeof mod.Checkbox).toBe("function");
  });

  test("Form exports Form and FormField", async () => {
    const mod = await import("../../components/ui/form");
    expect(typeof mod.Form).toBe("function");
    expect(typeof mod.FormField).toBe("function");
  });

  test("Accordion exports Accordion, AccordionItem, AccordionTrigger, AccordionContent", async () => {
    const mod = await import("../../components/ui/accordion");
    expect(typeof mod.Accordion).toBe("function");
    expect(typeof mod.AccordionItem).toBe("function");
  });

  test("Calendar exports Calendar", async () => {
    const mod = await import("../../components/ui/calendar");
    expect(typeof mod.Calendar).toBe("function");
  });

  test("Skeleton exports Skeleton", async () => {
    const mod = await import("../../components/ui/skeleton");
    expect(typeof mod.Skeleton).toBe("function");
  });

  test("AlertDialog exports AlertDialog, AlertDialogContent", async () => {
    const mod = await import("../../components/ui/alert-dialog");
    expect(typeof mod.AlertDialog).toBe("function");
    expect(typeof mod.AlertDialogContent).toBe("function");
  });
});

describe("cn utility function", () => {
  test("concatenates class names", async () => {
    const { cn } = await import("../../src/lib/utils" as string);
    expect(cn("a", "b")).toBe("a b");
  });

  test("filters falsy values", async () => {
    const { cn } = await import("../../src/lib/utils" as string);
    expect(cn("a", false && "b")).toBe("a");
  });
});
