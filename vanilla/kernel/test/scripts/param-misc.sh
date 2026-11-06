echo ${u:-def} ${u:=set} $u ${u:+alt} ${e-x} ${e:-y}
e=; echo "[${e-x}][${e:-y}][${e+z}][${e:+w}]"
s=abcdef; echo ${s:2} ${s:1:3} ${s: -2} ${s:0:-1} ${s:10}
set -- a b c d; echo ${@:2} ${*:2:2} ${@: -1}
for x in "${@:2:2}"; do echo "<$x>"; done
w=hello; echo ${w^} ${w^^} ${w^^[el]}; W=HELLO; echo ${W,} ${W,,}
echo ${#s} ${#}
a=b; b=val; echo ${!a}
echo ${nope:?custom message}; echo not-reached
