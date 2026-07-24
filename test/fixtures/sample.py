"""A sample Python module used as an AST fixture."""
import os


GREETING = "hello"


def add(a, b):
    return a + b


class Account:
    def __init__(self, balance):
        self.balance = balance

    def deposit(self, amount):
        self.balance += amount

    @property
    def is_empty(self):
        return self.balance == 0


async def load_config(path):
    with open(path) as f:
        return f.read()
