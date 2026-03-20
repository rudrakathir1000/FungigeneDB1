import re

with open("app.py", "r", encoding="utf-8") as f:
    code = f.read()

old = 'f\'(protein_name:"{escaped}" OR gene:"{escaped}" OR accession:{escaped})\''
new = 'f\'(protein_name:"{escaped}" OR gene:"{escaped}" OR ({escaped}))\''

code = code.replace(old, new)

with open("app.py", "w", encoding="utf-8") as f:
    f.write(code)

print("Backend patched.")
