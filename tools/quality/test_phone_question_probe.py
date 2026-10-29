import unittest
from xml.etree import ElementTree as ET

from verify_phone_question import turn_texts


class TurnTextScopeTest(unittest.TestCase):
    def test_android_flattened_accessibility_siblings(self):
        root = ET.fromstring('''<hierarchy>
          <node resource-id="meeting-question-turn-0" bounds="[20,100][400,300]" />
          <node package="com.laoji.app" text="full question?" bounds="[100,110][380,160]" />
          <node package="com.laoji.app" text="real answer" bounds="[30,180][390,250]" />
          <node package="com.laoji.app" text="another turn" bounds="[30,310][390,350]" />
          <node package="other.app" text="not our text" bounds="[30,190][390,220]" />
        </hierarchy>''')
        nodes = list(root.iter('node'))
        self.assertEqual(turn_texts(nodes, nodes[0]), ['full question?', 'real answer'])


if __name__ == '__main__':
    unittest.main()
