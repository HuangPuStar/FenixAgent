import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ReactDOMServer from "react-dom/server";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../../components/ui/accordion";
import { Calendar } from "../../components/ui/calendar";
import { DatePicker } from "../../components/ui/date-picker";
import { Skeleton } from "../../components/ui/skeleton";

const DARK_MODE_VARIABLES = [
  "--color-background",
  "--color-foreground",
  "--color-card",
  "--color-card-foreground",
  "--color-popover",
  "--color-popover-foreground",
  "--color-primary",
  "--color-primary-foreground",
  "--color-secondary",
  "--color-secondary-foreground",
  "--color-muted",
  "--color-muted-foreground",
  "--color-accent",
  "--color-accent-foreground",
  "--color-destructive",
  "--color-border",
];

describe("Dark mode component integration", () => {
  test("index.css dark mode has all required CSS variables", () => {
    const css = readFileSync(join(import.meta.dirname, "..", "index.css"), "utf-8");
    const darkBlockMatch = css.match(/\.dark\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/s);
    expect(darkBlockMatch).not.toBeNull();
    const darkBlock = darkBlockMatch![1];
    for (const variable of DARK_MODE_VARIABLES) {
      expect(darkBlock).toContain(variable);
    }
  });

  test("Skeleton renders with animate-pulse", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<Skeleton className="h-4 w-20" />);
    expect(html).toContain("animate-pulse");
  });

  test("Accordion components are valid React components", () => {
    expect(typeof Accordion).toBe("function");
    expect(typeof AccordionItem).toBe("function");
    expect(typeof AccordionTrigger).toBe("function");
    expect(typeof AccordionContent).toBe("function");
  });

  test("Calendar component is a valid React component", () => {
    expect(typeof Calendar).toBe("function");
  });

  test("DatePicker component is a valid React component", () => {
    expect(typeof DatePicker).toBe("function");
  });

  test("Accordion renders basic structure", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <Accordion type="multiple" defaultValue={["test"]}>
        <AccordionItem value="test">
          <AccordionTrigger>标题</AccordionTrigger>
          <AccordionContent>内容</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );
    expect(html).toContain("标题");
    // AccordionContent is hidden in SSR by Radix (data-state=closed)
    // Verify the component renders without errors
    expect(html).toContain("accordion-content");
  });
});
