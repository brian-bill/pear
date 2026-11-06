printf 'a 1\nb 2\nc 3\n' > /tmp/aw
awk '{ s += $2 } END { print s, NR }' /tmp/aw
awk -F: '{ print $1 }' <<< 'x:y:z'
awk '$2 > 1 { print $1 }' /tmp/aw | tr '\n' ' '; echo
awk 'BEGIN { printf "%5.2f|%-4s|%d\n", 3.14159, "ab", 42 }'
awk 'NR==2' /tmp/aw
awk '/b/,/c/' /tmp/aw | tr '\n' ';'; echo
awk '{ a[$1] = $2 } END { for (k in a) n++; print n, a["b"] }' /tmp/aw
awk 'function f(x) { return x * 2 } BEGIN { print f(21) }'
awk '{ $2 = $2 * 10 } 1' /tmp/aw | tr '\n' ';'; echo
awk '{ print NF, length($0) }' <<< 'one two  three'
awk 'BEGIN { s = "hello world"; gsub(/o/, "0", s); print s; print toupper(substr(s, 1, 5)), index(s, "w") }'
awk 'BEGIN { n = split("a,b,c", p, ","); print n, p[3]; print length(p) }'
awk -v x=5 'BEGIN { print x + 1; print (x > 3 ? "big" : "small") }'
awk 'BEGIN { print 1/3; print 10 % 3, 2 ^ 10, int(7.9) }'
awk '{ print > "/tmp/aw.out" } END { close("/tmp/aw.out"); while ((getline l < "/tmp/aw.out") > 0) n++; print n }' /tmp/aw
echo 'x y' | awk '{ print $2, $1 }' OFS=-
awk 'BEGIN { while (i++ < 3) printf "%d ", i; print "" }'
awk 'BEGIN { "echo hi" | getline v; print v }'
awk 'END { print $0 }' /tmp/aw
awk 'BEGIN { if (!("a" in x)) print "no"; x["a"]; if ("a" in x) print "yes" }'
awk '{ print (NR % 2 ? "odd" : "even") }' /tmp/aw | tr '\n' ' '; echo
awk 'BEGIN { printf "%c%c\n", 65, "BCD" }'
awk 'BEGIN { x["a",1]=2; for (k in x) { split(k, q, SUBSEP); print q[1], q[2] } }'
awk 'BEGIN { print (1, 2) }'
awk '$1 == "b" { next } { print $1 }' /tmp/aw | tr '\n' ' '; echo
echo '3 4' | awk '{ print $1 * $2, $1 $2, $1 < $2, ($1 "") < ($2 "") }'
awk 'BEGIN { print substr("hello", 2, 3), substr("hello", 0), substr("hello", -1, 3) }'
awk 'BEGIN { print length("héllo"), tolower("ABC") }'
awk 'BEGIN { exit 3 } END { print "end ran" }'; echo st=$?
echo 'a,b;c' | awk -F'[,;]' '{ print $3 $2 $1 }'
echo 'k=v' | awk '{ sub(/=/, " -> "); print }'
echo 'aaa' | awk '{ print gsub(/a/, "&&"), $0 }'
awk 'BEGIN { print 100000 * 100000, 0.1 + 0.2, 1e3, "1e3" + 0 }'
