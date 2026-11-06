rm -rf /tmp/ft; mkdir -p /tmp/ft/a/b /tmp/ft/empty; touch /tmp/ft/x.txt /tmp/ft/a/y.txt /tmp/ft/a/b/z.md
find /tmp/ft -name '*.txt'
find /tmp/ft -type d
find /tmp/ft -maxdepth 1 -type f
find /tmp/ft -name '*.md' -exec echo found {} \;
find /tmp/ft -type f ! -name '*.txt'
find /tmp/ft -type f \( -name x.txt -o -name z.md \)
find /tmp/ft -empty -type d
find /tmp/ft -mindepth 2 -maxdepth 2
cd /tmp/ft; find . -name y.txt
find . -type f -print0 | tr '\0' ' '; echo
find /tmp/ft -type f -delete; find /tmp/ft -type f | wc -l
find /nonexistent; echo st=$?
du -s /tmp/ft | cut -f2
du -a /tmp/ft | cut -f2 | head -3
df | head -1 | cut -c1-10
