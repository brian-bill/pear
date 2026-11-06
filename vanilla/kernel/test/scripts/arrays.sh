arr=(one "two words" three)
echo ${#arr[@]} ${arr[1]} ${arr[-1]} ${arr[0]} $arr
for x in "${arr[@]}"; do echo "[$x]"; done
arr+=(four); arr[6]=six
echo ${!arr[@]}
echo "${arr[*]}"
echo ${arr[@]:1:2}
unset 'arr[0]'; echo ${#arr[@]}
n=(1 2 3); echo $(( n[0] + n[2] )); n[1]=$(( n[2] * 5 )); (( n[0]++ )); echo ${n[@]}
declare -A m=([a]=1 [b]=2); m[c]=3; echo ${m[b]} ${#m[@]} ${!m[@]}
k=b; echo ${m[$k]}
read -a w <<< "x y z"; echo ${w[2]} ${#w[@]}
mapfile -t L <<< $'l1\nl2'; echo ${#L[@]} ${L[1]}
declare -a z=(p q); declare -p z
x=(); x+=(a b); echo ${#x[@]}
f() { local -a lc=(1 2); echo ${#lc[@]}; }; f; echo "${lc[@]:-gone}"
(arr=(sub)); echo ${#arr[@]}
