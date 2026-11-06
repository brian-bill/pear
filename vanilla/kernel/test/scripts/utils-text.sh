printf 'b\na\nc\na\n' | sort | uniq -c
printf '10\n9\n100\n' | sort -n | tr '\n' ' '; echo
printf '10\n9\n100\n' | sort -rn | tr '\n' ' '; echo
printf 'b,2\na,10\nc,1\n' | sort -t, -k2 -n | tr '\n' ' '; echo
printf 'b\na\nb\n' | sort -u | tr '\n' ' '; echo
printf 'x\nx\ny\n' | uniq -d
echo a:b:c | cut -d: -f1,3
echo hello | cut -c2-4
echo hello | tr a-z A-Z
echo 'a   b' | tr -s ' '
echo abc123 | tr -d 0-9
echo hello | tr -cd 'a-h'; echo
printf 'a b c' | xargs echo x
printf '1\n2\n' | xargs -n1 echo n
printf 'a\nb\n' | xargs -I{} echo '[{}]'
