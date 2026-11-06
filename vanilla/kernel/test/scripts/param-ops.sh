f=/usr/local/bin/file.tar.gz
echo ${f#*/} ${f##*/} ${f%.*} ${f%%.*}
echo ${f/local/LOCAL} ${f//\//:} ${f/#\/usr/X} ${f/%gz/zip}
echo "${f/bin}" ${f//[aeiou]/_}
p=a.b.c; echo ${p%.*} ${p%%.*} ${p#*.} ${p##*.}
q='x y'; echo "${q// /_}"
