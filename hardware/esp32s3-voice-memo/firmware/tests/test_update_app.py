import importlib.util
import struct
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('update_app', Path(__file__).resolve().parents[1] / 'tools/update_app.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class UpdateGuardTest(unittest.TestCase):
    def setUp(self):
        self.head = bytearray(b'\xff' * module.OFFSET)
        struct.pack_into('<HBBII16sI', self.head, 0x8000, 0x50aa, 0, 0, module.OFFSET, module.SIZE, b'factory', 0)
        self.image = bytearray(b'\0' * 128); self.image[0] = 0xe9
        struct.pack_into('<H', self.image, 12, 9)
        struct.pack_into('<I', self.image, 0x20, 0xabcd5432)
        self.app = self.image + bytearray(b'\xff' * (module.SIZE - len(self.image)))

    def test_exact_current_baseline_and_layout_accepted(self):
        module.validate(self.head, self.app, self.image, self.image)

    def test_different_app_rejected(self):
        self.app[100] ^= 1
        with self.assertRaises(ValueError): module.validate(self.head, self.app, self.image, self.image)

    def test_old_non_erased_tail_rejected(self):
        self.app[-1] = 1
        with self.assertRaises(ValueError): module.validate(self.head, self.app, self.image, self.image)

    def test_other_partition_layout_rejected(self):
        struct.pack_into('<I', self.head, 0x8008, 0x100000)
        with self.assertRaises(ValueError): module.validate(self.head, self.app, self.image, self.image)

    def test_oversize_and_donor_images_rejected(self):
        for image in (b'\xe9' * (module.SIZE + 1), b'\xe9' * 128, b''):
            with self.assertRaises(ValueError): module.validate(self.head, self.app, self.image, image)


if __name__ == '__main__':
    unittest.main()
