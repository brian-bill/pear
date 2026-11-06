printf '1\n2\n3\n' > /tmp/da; printf '1\nx\n3\n4\n' > /tmp/db
diff /tmp/da /tmp/db
diff /tmp/da /tmp/da; echo same=$?
diff -u /tmp/da /tmp/db | tail -n +3
diff -q /tmp/da /tmp/db
cmp /tmp/da /tmp/db; echo cmp=$?
cmp /tmp/da /tmp/da; echo cmp=$?
