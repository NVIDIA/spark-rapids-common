#!/bin/bash

# SC2206 (warning): Quote to prevent word splitting/globbing, or split robustly with mapfile or read -a.
# bloopDirsGenerated=()
# bloopDir='spark 356'
# bloopDirsGenerated+=("$bloopDir")
# for item in "${bloopDirsGenerated[@]}"; do
# echo $item
# done

# SC2124 (warning): Assigning an array to a string! Assign as array, or use * instead of @ to concatenate.
# IFS=" " read -ra ARGS <<< "$(find . -name "*.yaml" -printf "%p ")"
# for item in "${ARGS[@]}"; do
#   echo $item
# done
# echo "${ARGS[@]}"

SKIP_TESTS="TRUE"
if [[ $( echo ${SKIP_TESTS} | tr [:upper:] [:lower:] ) == "true" ]];
then
    echo "PYTHON INTEGRATION TESTS SKIPPED..."
fi

# GPU_MEM_PARALLEL=1
# CPU_CORES=2
# TMP_PARALLEL=$(( GPU_MEM_PARALLEL > CPU_CORES ? CPU_CORES : GPU_MEM_PARALLEL ))
# echo $TMP_PARALLEL

# TMP_PARALLEL=10
# if (( TMP_PARALLEL <= 1 )); then
#     TEST_PARALLEL=1
# else
#     TEST_PARALLEL=$TMP_PARALLEL
# fi
# echo $TEST_PARALLEL

# TESTS="api_test login_test db_query"

# read -ra RAW_TESTS <<< "${TESTS}"
# for raw_test in "${RAW_TESTS[@]}"; do
#   echo "Running test: $raw_test"
# done

# sed_i() {
#   sed -e "$1" "$2" > "$2.tmp" && mv "$2.tmp" "$2"
# }
# SPARK_VERSION='spark330'
# sed_i '/<java\.major\.version>/,/<spark\.version>\${spark[0-9]\+\.version}</s/<spark\.version>\${spark[0-9]\+\.version}</<spark.version>\${'$SPARK_VERSION'.version}</' \
#   "pom.xml"

# BASE_SPARK_VERSION="320.dev"
# BUILDVER=${BASE_SPARK_VERSION//./}db
# echo $BUILDVER

# REQUIRED_PACKAGES=("existing-pkg" "with space" "c*")
# CUDA_VER="11.0"
# CUDF_VER="22.0"
# REQUIRED_PACKAGES=(
#   "cuda-version=$CUDA_VER"
#   "cudf=$CUDF_VER"
#   "${REQUIRED_PACKAGES[@]}"
# )
# for item in "${REQUIRED_PACKAGES[@]}"; do
#   echo $item
# done

# CLASSIFIERS="cuda12,cuda12-arm64"
# DEPLOY_TYPES=${CLASSIFIERS//[^,]?/jar}
# # DEPLOY_TYPES=$(echo $CLASSIFIERS | sed -e 's;[^,]*;jar;g')
# echo $DEPLOY_TYPES

# PHASE_TYPE="330 331 340 350 356"
# echo "original output:"
# SPARK_SHIM_VERSIONS=(`echo "$PHASE_TYPE"`)
# echo "${SPARK_SHIM_VERSIONS[@]}"
# echo "new output:"
# IFS=" " read -ra SPARK_SHIM_VERSIONS <<< $PHASE_TYPE
# echo "${SPARK_SHIM_VERSIONS[@]}"
# # for item in "${SPARK_SHIM_VERSIONS[@]}"; do
# #   echo $item
# # done


# PROFILE_OPT="-PpremergeUT1"
# # SPARK_SHIM_VERSIONS_STR=$(mvn -B help:evaluate -q -pl dist $PROFILE_OPT -Dexpression=included_buildvers -DforceStdout)
# SPARK_SHIM_VERSIONS_STR=$(echo -n $(mvn -B help:evaluate -q -pl dist $PROFILE_OPT -Dexpression=included_buildvers -DforceStdout))
# # SPARK_SHIM_VERSIONS_STR=$(echo $SPARK_SHIM_VERSIONS_STR)
# # echo "$SPARK_SHIM_VERSIONS_STR"
# IFS=", " <<< $SPARK_SHIM_VERSIONS_STR read -r -a SPARK_SHIM_VERSIONS_ARR
# for item in "${SPARK_SHIM_VERSIONS_ARR[@]}"; do
#   echo $item
# done

# SPARK_SHIM_VERSIONS_NOSNAPSHOTS_TAIL=(320 310 310db 330)
# SPARK_SHIM_VERSIONS_PREMERGE_UT_1=(321 330)
# for version in "${SPARK_SHIM_VERSIONS_NOSNAPSHOTS_TAIL[@]}"
# do
#     echo "Spark version: $version"
#     # build and run unit tests on one specific version for each sub-version (e.g. 320, 330) except base version
#     # separate the versions to two ci stages (mvn_verify, ci_2) for balancing the duration
#     match=1
#     for element in "${SPARK_SHIM_VERSIONS_PREMERGE_UT_1[@]}"; do
#         if [[ "$element" == "$version" ]]; then
#             match=0
#             break
#         fi
#     done
#     if [[ $match == 0 ]]; then
#         echo "yes"
#     fi
# done



# HOST_MEM_PARALLEL=$(awk '/MemAvailable/ {print int($2 / (8 * 1024 * 1024))}' /proc/meminfo)
# # HOST_MEM_PARALLEL=`cat /proc/meminfo | grep MemAvailable | awk '{print int($2 / (8 * 1024 * 1024))}'`
# echo $HOST_MEM_PARALLEL

# REPORT_CHARS=${REPORT_CHARS:="fE"}
# if [[ "${TEST_TAGS}" != "" ]];
# then
#     TEST_TAGS="-m $TEST_TAGS"
# fi
# STD_INPUT_PATH="test/path"
# TEST_TYPE_PARAM=""
# TEST_TYPE="pre-commit"
# if [[ "${TEST_TYPE}" != "" ]];
# then
#     TEST_TYPE_PARAM="--test_type=$TEST_TYPE"
# fi
#  if [[ "${TEST}" != "" ]];
# then
#     TEST_ARGS="-k $TEST"
# fi
# TEST_COMMON_OPTS=(-v
#     -r"$REPORT_CHARS"
#     "$TEST_TAGS"
#     --std_input_path="$STD_INPUT_PATH"
#     --color=yes
#     "$TEST_TYPE_PARAM"
#     "$TEST_ARGS"
#     --junitxml=TEST-pytest-`date +%s%N`.xml
#     "$@")
# echo "${TEST_COMMON_OPTS[@]}"

# declare -a path_parts='([0]="" [1]="spark320" [2]="com" [3]="nvidia" [4]="spark" [5]="udf" [6]="Repr\$UnknownCapturedArg\$.class")'
