	.file	"compare.c"
	.intel_syntax noprefix
	.text
	.globl	add32
	.type	add32, @function
add32:
	endbr64
	push	rbp
	mov	rbp, rsp
	mov	DWORD PTR 16[rbp], ecx
	mov	DWORD PTR 24[rbp], edx
	mov	edx, DWORD PTR 16[rbp]
	mov	eax, DWORD PTR 24[rbp]
	add	eax, edx
	pop	rbp
	ret
	.size	add32, .-add32
	.globl	less_signed
	.type	less_signed, @function
less_signed:
	endbr64
	push	rbp
	mov	rbp, rsp
	sub	rsp, 16
	mov	DWORD PTR 16[rbp], ecx
	mov	DWORD PTR 24[rbp], edx
	mov	DWORD PTR -4[rbp], 0
	mov	eax, DWORD PTR 16[rbp]
	cmp	eax, DWORD PTR 24[rbp]
	jge	.L4
	mov	DWORD PTR -4[rbp], 1
.L4:
	mov	eax, DWORD PTR -4[rbp]
	leave
	ret
	.size	less_signed, .-less_signed
	.globl	less_unsigned
	.type	less_unsigned, @function
less_unsigned:
	endbr64
	push	rbp
	mov	rbp, rsp
	sub	rsp, 16
	mov	DWORD PTR 16[rbp], ecx
	mov	DWORD PTR 24[rbp], edx
	mov	DWORD PTR -4[rbp], 0
	mov	eax, DWORD PTR 16[rbp]
	cmp	eax, DWORD PTR 24[rbp]
	jnb	.L7
	mov	DWORD PTR -4[rbp], 1
.L7:
	mov	eax, DWORD PTR -4[rbp]
	leave
	ret
	.size	less_unsigned, .-less_unsigned
	.globl	sum_to
	.type	sum_to, @function
sum_to:
	endbr64
	push	rbp
	mov	rbp, rsp
	sub	rsp, 16
	mov	DWORD PTR 16[rbp], ecx
	mov	DWORD PTR -4[rbp], 0
	mov	DWORD PTR -8[rbp], 0
	jmp	.L10
.L11:
	mov	eax, DWORD PTR -4[rbp]
	add	DWORD PTR -8[rbp], eax
	add	DWORD PTR -4[rbp], 1
.L10:
	mov	eax, DWORD PTR -4[rbp]
	cmp	eax, DWORD PTR 16[rbp]
	jb	.L11
	mov	eax, DWORD PTR -8[rbp]
	leave
	ret
	.size	sum_to, .-sum_to
	.globl	read_at
	.type	read_at, @function
read_at:
	endbr64
	push	rbp
	mov	rbp, rsp
	mov	QWORD PTR 16[rbp], rcx
	mov	DWORD PTR 24[rbp], edx
	mov	eax, DWORD PTR 24[rbp]
	lea	rdx, 0[0+rax*4]
	mov	rax, QWORD PTR 16[rbp]
	add	rax, rdx
	mov	eax, DWORD PTR [rax]
	pop	rbp
	ret
	.size	read_at, .-read_at
	.globl	caller
	.type	caller, @function
caller:
	endbr64
	push	rbp
	mov	rbp, rsp
	sub	rsp, 32
	mov	edx, 3
	mov	ecx, 2
	call	add32
	leave
	ret
	.size	caller, .-caller
	.ident	"GCC: (Ubuntu 11.4.0-1ubuntu1~22.04.3) 11.4.0"
	.section	.note.GNU-stack,"",@progbits
	.section	.note.gnu.property,"a"
	.align 8
	.long	1f - 0f
	.long	4f - 1f
	.long	5
0:
	.string	"GNU"
1:
	.align 8
	.long	0xc0000002
	.long	3f - 2f
2:
	.long	0x3
3:
	.align 8
4:
