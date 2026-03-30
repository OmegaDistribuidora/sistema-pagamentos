import { Prisma } from "@prisma/client";

export function decimalToNumber(value: Prisma.Decimal | number | string | null | undefined): number {
  if (value == null) {
    return 0;
  }

  if (typeof value === "number") {
    return value;
  }

  return Number(value);
}
