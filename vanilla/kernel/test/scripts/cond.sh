[[ abc == a* ]] && echo m1
[[ abc != a* ]] || echo m2
x="a b"; [[ $x == "a b" ]] && echo m3
[[ $x == a\ b ]] && echo m4
[[ foo123 =~ ^([a-z]+)([0-9]+)$ ]] && echo ${BASH_REMATCH[0]} ${BASH_REMATCH[1]} ${BASH_REMATCH[2]}
[[ -n $x && ( a < b || 1 -eq 2 ) ]] && echo m5
[[ -z $unset ]] && echo m6
[[ ! -e /nonexistent ]] && echo m7
[[ -d /tmp && -f /bin/sh ]] && echo m8
[[ 10 -gt 9 && 2 -lt 3 ]] && echo m9
[[ -v x ]] && echo m10
[[ nope == x ]]; echo st=$?
