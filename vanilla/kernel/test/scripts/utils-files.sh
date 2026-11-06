rm -rf /tmp/u; mkdir -p /tmp/u/a/b; rmdir /tmp/u/a/b; ls /tmp/u/a | wc -l
echo hi > /tmp/u/f; ln -s f /tmp/u/l; readlink /tmp/u/l; cat /tmp/u/l
chmod 600 /tmp/u/f; stat -c '%a %s %F' /tmp/u/f
chmod u+x,g=r /tmp/u/f; stat -c %a /tmp/u/f
realpath /tmp/u/../u/l
which sh; which nosuch; echo which=$?
basename /a/b/c.txt .txt; dirname /a/b/c.txt; dirname file
d=$(mktemp -d); [ -d $d ] && echo dir; f=$(mktemp); [ -f $f ] && echo file
seq 3 | tee /tmp/u/t | wc -l; cat /tmp/u/t | tr '\n' ' '; echo
seq 2 2 8 | tr '\n' ' '; echo
seq -w 8 10 | tr '\n' ' '; echo
uname -s; hostname
date -u -d @0 +%Y-%m-%dT%H:%M:%S
date -u -d @86400 '+%a %b %e %j'
printf 'abcdef' | head -c 3; echo; printf 'abcdef' | tail -c 2; echo
printenv HOME
