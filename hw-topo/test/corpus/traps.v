// 恶劣语料:每个陷阱一个标记,扫描器要么提取对、要么如实报告,不允许错提/崩溃
`timescale 1ns/1ps
`define WIDTH 8
`ifdef NOTHING
module ghost_ifdef (output x);
  assign x = 1'b0;
endmodule
`endif

// T1: 普通 ANSI 模块(基准)
module good_top (
    input  wire clk,
    output wire [7:0] q
);
    // T2: 注释里的假例化
    // fake_in_comment u_c (.a(b));

    /* T3: 块注释里的假例化
       fake_in_block u_b (.a(b));
    */

    // T4: 字符串里的假例化
    initial $display("fake_in_str u_s (.a(b));");

    // T5: 宏名后跟任务调用(`ifdef 套路)
`ifdef TRAP_MACRO
    trap_task_call(sig);
`endif

    // T6: .* 隐式连接
    leaf u_star (.*);

    // T7: 位置连接 + 参数带函数调用
    leaf #(.W($clog2(8))) u_pos (clk, q);

    // T8: 数组例化(合法但扫描器已知会漏报——必须不产生错报)
    // leaf u_arr[3:0] (.clk(clk), .q(q));

    // T9: 层次名调用
    // initial u_star.debug(1);

    // T10: generate 块
    genvar i;
    generate
        for (i = 0; i < 2; i = i + 1) begin : g
            leaf u_gen (.clk(clk), .q(q[i*4 +: 4]));
        end
    endgenerate
endmodule

// T11: 非ANSI 端口 + 多端口一行
module legacy (a, b, c);
    input a, b;
    output c;
    wire c = a & b;
endmodule

// T12: interface(SV)
interface my_bus (input wire clk);
    logic req;
    logic gnt;
    modport m (output req, input gnt);
endinterface

// T13: 转义标识符
module escaped (\bus+wires.a , \clk!special );
    input \bus+wires.a ;
    input \clk!special ;
    wire ok = \bus+wires.a  & \clk!special ;
endmodule

// T14: bind 语句(SV)
// bind good_top binder u_bind (.clk(clk));

// T15: 单行模块
module tiny (output y); assign y = 1'b1; endmodule

// T16: module 前有属性
(* keep *) module attr_mod (input a, output z);
   assign z = ~a;
endmodule

// T17: package(不含模块)
package pkg_t;
    parameter int P = 4;
endpackage

// T18: 无端口模块
module no_ports;
    reg r;
endmodule

// T19: endmodule 拼写陷阱:endmodule 后跟注释
module trailing_c (input c, output t);
    assign t = c;
endmodule // trailing comment

// T20: 时钟原语(SB_GB_IO 双例化在同一行? 分开写)
`default_nettype none
module prim_user (input clk_i);
    SB_GB_IO u_gb (
        .PACKAGE_PIN (clk_i),
        .OUTPUT_CLK  (clk_i),
        .D_OUT_0     ()
    );
endmodule
`default_nettype wire

// T21: SV always_ff / always_comb / 断言
module sv_mod (input logic clk, input logic rst, output logic [3:0] cnt_o);
    always_ff @(posedge clk or negedge rst) begin
        if (!rst) cnt_o <= '0;
        else      cnt_o <= cnt_o + 1'b1;
    end
    assert property (@(posedge clk) cnt_o >= 0);
endmodule

// T22: 大小写敏感的近似名(检查不会混淆)
module Leaf_CNTR (input c, output q);
    assign q = c;
endmodule

module leaf (input wire clk, output wire [7:0] q);
    parameter W = 8;
    assign q = '0;
endmodule
