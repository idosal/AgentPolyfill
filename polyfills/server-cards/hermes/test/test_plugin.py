import sys
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parents[2] / "tools/hermes"))
from card_unit import UnitScenarios


class ServerCardsUnit(UnitScenarios, unittest.TestCase):
    ROOT = ROOT
    PLUGIN = "mcp-server-cards"
