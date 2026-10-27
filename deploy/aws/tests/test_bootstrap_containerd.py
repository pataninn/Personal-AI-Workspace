import ast
from pathlib import Path
import re
import tomllib
import unittest


class ContainerdRootTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = (Path(__file__).resolve().parents[1] / 'bootstrap-base.sh').read_text()
        blocks = re.findall(r"python3 - <<'PY'\n(.*?)\nPY", source, re.S)
        block = next(item for item in blocks if 'def retained_containerd_root' in item)
        tree = ast.parse(block)
        function = next(item for item in tree.body if isinstance(item, ast.FunctionDef))
        namespace = {'re': re, 'tomllib': tomllib}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<containerd-root>', 'exec'), namespace)
        cls.configure = staticmethod(namespace['retained_containerd_root'])

    def test_both_vendor_quote_styles_move_only_the_global_root(self):
        for quote in ["'", '"']:
            with self.subTest(quote=quote):
                source = f'version = 3\nroot = {quote}/var/lib/containerd{quote}\n[plugins.example]\nroot = "/different/plugin/path"\n'
                configured = tomllib.loads(self.configure(source))
                self.assertEqual(configured['root'], '/mnt/pai-data/containerd')
                self.assertEqual(configured['plugins']['example']['root'], '/different/plugin/path')

    def test_missing_or_duplicate_global_root_is_rejected(self):
        for source in ['version = 3\n', 'root="/one"\nroot="/two"\n']:
            with self.subTest(source=source):
                with self.assertRaises(RuntimeError):
                    self.configure(source)


if __name__ == '__main__':
    unittest.main()
