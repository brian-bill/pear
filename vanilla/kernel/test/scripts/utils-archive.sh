rm -rf /tmp/ar; mkdir -p /tmp/ar/src/sub; echo hello > /tmp/ar/src/a.txt; echo deep > /tmp/ar/src/sub/b.txt; ln -s a.txt /tmp/ar/src/l
cd /tmp/ar
gzip -k src/a.txt; ls src | tr '\n' ' '; echo
zcat src/a.txt.gz
gunzip -c src/a.txt.gz
printf 'streamed' | gzip | gunzip; echo
tar -cf t.tar src; tar -tf t.tar | tr '\n' ' '; echo
mkdir out; tar -xf t.tar -C out; cat out/src/sub/b.txt; readlink out/src/l
tar czf t.tgz src; tar tzf t.tgz | head -2 | tr '\n' ' '; echo
mkdir out2; tar -xzf t.tgz -C out2 --strip-components=1; ls out2 | tr '\n' ' '; echo
zip -rq z.zip src; unzip -l z.zip | tail -1 | awk '{ print $2, $3 }'
mkdir out3; unzip -q -d out3 z.zip; cat out3/src/a.txt
unzip -p z.zip src/sub/b.txt
unzip -q -d out3 z.zip 2>/dev/null; echo st=$?
unzip -qo -d out3 z.zip; echo st=$?
chmod 755 src/a.txt; tar -cf m.tar src/a.txt; mkdir o4; tar -xf m.tar -C o4; stat -c %a o4/src/a.txt
d=$(printf 'x%.0s' $(seq 1 120)); mkdir -p lng/$d; echo z > lng/$d/f; tar -cf l.tar lng; tar -tf l.tar | tail -1 | wc -c
mkdir o5; tar -xf l.tar -C o5; cat o5/lng/$d/f
gzip src/sub/b.txt; ls src/sub; gunzip src/sub/b.txt.gz; ls src/sub
