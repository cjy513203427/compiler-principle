#include <stdio.h>
#include "../../public/assembly/compare.c"
int main(void) {
  i32 values[] = {10, 20, 30, -1};
  if (add32(2, 3) != 5 || add32(0xFFFFFFFFu, 1) != 0 ||
      less_signed(-1, 1) != 1 || less_unsigned(0xFFFFFFFFu, 1) != 0 ||
      sum_to(4) != 6 || sum_to(0) != 0 || read_at(values, 2) != 30 ||
      read_at(values, 3) != -1 || caller() != 5) return 1;
  puts("9 native checks passed");
  return 0;
}
