#!/bin/bash
# shellcheck disable=SC2317  # Temporarily disable checks to demonstrate errors

# =====================
# Basic Syntax Errors (detectable by both bash -n and shellcheck)
# =====================

# 1. Unmatched quotes
echo "Hello World   # Error: Missing closing quote

# 2. Unclosed control structure
if [ -f "test_file.txt" ]; then
  echo "File exists"
# Error: Missing 'fi'

# 3. Incomplete pipe command
cat "some_file.txt" |   # Error: Nothing after pipe

# 4. Unclosed function
function test_function {
  echo "Inside function"
# Error: Missing '}'

# =====================
# Semantic Errors (primarily detected by shellcheck)
# =====================

# 5. Unquoted variable with spaces
filename="file with spaces.txt"
rm $filename  # Error: Should be rm "$filename"

# 6. Misuse of exit status
grep "pattern" "some_file.txt"
if [ $? = 0 ]; then  # Error: Should use if grep -q "pattern" file.txt
  echo "Pattern found"
fi

# 7. Uninitialized variable
echo "Value: $undefined_var"  # Error: Variable never defined

# 8. Arithmetic expression error
count=5+3  # Error: Should be count=$((5+3))

# 9. Test expression error
var="value"
if [ "$var" = value ]; then  # Error: value should be quoted
  echo "Equal"
fi

# =====================
# Security/Best Practice Issues (shellcheck only)
# =====================

# 10. Command injection risk
user_input="; echo 'malicious command'"
ls $user_input  # Error: Should use ls -- "$user_input"

# 11. Inefficient loop
for file in $(ls *.txt); do  # Error: Should use for file in *.txt
  echo "$file"
done

# 12. Constant conditional
if [[ 1 -eq 1 ]]; then  # Error: Always true
  echo "Always true"
fi

# 13. Unclosed file descriptor
exec 3< "input.txt"
# Error: Missing exec 3>&-

# =====================
# Portability Issues (shellcheck only)
# =====================

# 14. Bashism in sh script
(
  #!/bin/sh
  echo {1..10}  # Error: {} expansion invalid in POSIX sh
)

# 15. Incompatible test syntax
(
  #!/bin/sh
  if [[ $var == "test" ]]; then  # Error: [[ ]] is bash-specific
    echo "Match"
  fi
)

# =====================
# Compound Error Section
# =====================

# 16. Multiple compound errors
echo "Starting complex error section"

# Unmatched quotes
echo "Unclosed quote

# Uninitialized variable + unquoted
if [ $debug_mode = "true" ]; then
  echo "Debug mode"
fi

# Broken pipe
cat /var/log/syslog | 

# Security risk
find . -name $user_input

# Unclosed loop
for item in {1..5}; do
  echo "Processing $item"

# =====================
# Cleanup (no actual errors)
# =====================
echo "All errors are intentional test cases"
exit 0