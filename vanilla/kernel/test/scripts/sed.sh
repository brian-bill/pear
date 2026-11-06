printf 'one\ntwo\nthree\n' > /tmp/sd
sed 's/o/0/' /tmp/sd | tr '\n' ' '; echo
sed 's/o/0/g;s/e$/E/' /tmp/sd | tr '\n' ' '; echo
sed -n '2p' /tmp/sd
sed -n '2,3p' /tmp/sd | tr '\n' ' '; echo
sed '2d' /tmp/sd | tr '\n' ' '; echo
sed '$d' /tmp/sd | tr '\n' ' '; echo
sed '1!d' /tmp/sd
sed -n '/tw/,$p' /tmp/sd | tr '\n' ' '; echo
sed 's/\(t\)\(.\)/\2\1/' /tmp/sd | tr '\n' ' '; echo
sed -E 's/(t)(.)/\2\1/' /tmp/sd | tr '\n' ' '; echo
sed 's/.*/<&>/' /tmp/sd | head -1
echo aabbcc | sed 'y/abc/xyz/'
sed '2i\inserted' /tmp/sd | tr '\n' ' '; echo
sed '2a appended' /tmp/sd | tr '\n' ' '; echo
sed '2c changed' /tmp/sd | tr '\n' ' '; echo
sed -n -e '1{s/one/1/;p}' /tmp/sd
sed '$!N;s/\n/+/' /tmp/sd | tr '\n' ' '; echo
sed = /tmp/sd | sed 'N;s/\n/ /' | tr '\n' ';'; echo
sed 's/o/\U&/g' /tmp/sd | head -1
sed '/two/{n;d}' /tmp/sd | tr '\n' ' '; echo
sed 2q /tmp/sd | tr '\n' ' '; echo
sed -n '$=' /tmp/sd
echo "a.b" | sed 's/\./-/'
echo 'a b' | sed 's/[[:space:]]/_/'
sed '1~2d' /tmp/sd
sed -n '/one/{p;p}' /tmp/sd | tr '\n' ' '; echo
echo 'hello' | sed 's/l/L/2'
echo 'hello' | sed -n 's/l/L/gp'
echo 'path/to/x' | sed 's|/|:|g'
echo 'abc' | sed 's/b*/X/g'
printf 'a\nb\nc\n' | sed -n 'H;${x;s/\n/,/g;p}'
printf 'a\nb\n' | sed G | tr '\n' '_'; echo
sed -i.bak 's/two/2/' /tmp/sd; cat /tmp/sd | tr '\n' ' '; cat /tmp/sd.bak | tr '\n' ' '; echo
echo 'foo bar' | sed -e 's/foo/X/' -e 's/bar/Y/'
