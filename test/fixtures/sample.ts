// A sample TypeScript module used as an AST fixture.
import { readFile } from "node:fs/promises";

export const GREETING = "hello";

export interface User {
  id: number;
  name: string;
}

export type UserId = number;

export function add(a: number, b: number): number {
  return a + b;
}

export const multiply = (a: number, b: number): number => {
  return a * b;
};

export class Account {
  balance: number;

  constructor(balance: number) {
    this.balance = balance;
  }

  deposit(amount: number): void {
    this.balance += amount;
  }

  private log(message: string): void {
    console.log(message);
  }
}

async function loadConfig(path: string): Promise<string> {
  return readFile(path, "utf8");
}
