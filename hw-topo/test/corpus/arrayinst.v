module arr_top (input c, output [3:0] q);
    leaf u_arr[3:0] (.clk(c), .q(q));
endmodule
module leaf (input clk, output [3:0] q);
  assign q = 4 h F;
endmodule
