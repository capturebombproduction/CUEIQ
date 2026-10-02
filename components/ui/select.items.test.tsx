// A Select row has to ignore a long press: on Safari before 18.2 `select-none` alone
// (no autoprefixer in this build) let the press select the row's text instead of
// choosing the row.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

describe("SelectItem", () => {
  it("carries the -webkit- twin of select-none", () => {
    render(
      <Select open>
        <SelectTrigger aria-label="kind">
          <SelectValue placeholder="เลือก" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Alpha</SelectItem>
        </SelectContent>
      </Select>
    );
    const row = screen.getByRole("option", { name: "Alpha" });
    const c = (row.getAttribute("class") ?? "").split(/\s+/);
    expect(c).toContain("select-none");
    expect(c).toContain("[-webkit-user-select:none]");
  });
});
