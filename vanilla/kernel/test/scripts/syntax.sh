((x=5, y=x*2)); echo $x $y
(( x > 3 )) && echo big
((0)); echo st=$?
for ((i=0; i<3; i++)); do echo i=$i; done
for ((;;)); do echo once; break; done
v=world; cat <<< "hi $v"
[[ $'a\tb\x41' == "$(printf 'a\tbA')" ]] && echo ansi-ok
echo $(echo a) `echo b` "`echo c`"
cat <(echo from-psub) <(echo second)
wc -l < <(printf 'a\nb\n')
